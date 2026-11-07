import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { sameOrigin } from './member-routes.js';

const DAY = 86400000;
const BATCH = 24;
const PLAN_TTL = 10 * 60000;
const imageTypes = "COALESCE(mime_type, 'image/png') IN ('image/png', 'image/jpeg', 'image/webp')";
const fields = "id, token, created_at AS createdAt, mime_type AS mimeType, json_extract(data, '$.file') AS file";
const ownerId = token => createHash('sha256').update(String(token || '')).digest('hex').slice(0, 32);
const error = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const retentionDays = value => {
  if (!Number.isInteger(value) || value < 0 || value > 3650) error(400, '保存天数须为 0–3650 的整数；0 表示永久保留');
  return value;
};
const reply = (res, value) => {
  const text = JSON.stringify(value);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};
async function json(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) error(415, '仅接受 JSON');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 32768) error(413, '请求过大'); chunks.push(chunk); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { error(400, 'JSON 格式错误'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') error(400, '请求内容无效');
  return body;
}

// 只扫描文件元信息；预览目标放在 SQLite 临时表，不把整库提示词和图片装进内存。
export class AdminGallery {
  constructor({ store, dataDir, now = Date.now, removeFile = unlink }) {
    this.store = store;
    this.imageDir = path.resolve(dataDir, 'images');
    this.now = now;
    this.removeFile = removeFile;
    this.plans = new Map();
    this.work = Promise.resolve();
    this.started = false;
  }

  async init() {
    await this.store.ensureLoaded();
    this.store.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_images_owner_created ON images (token, created_at);
      CREATE INDEX IF NOT EXISTS idx_images_created ON images (created_at);
      CREATE TEMP TABLE IF NOT EXISTS gallery_cleanup_targets (
        plan_id TEXT NOT NULL, image_id TEXT NOT NULL, PRIMARY KEY (plan_id, image_id)
      ) WITHOUT ROWID;
    `);
  }

  locked(fn) {
    const result = this.work.catch(() => {}).then(fn);
    this.work = result;
    return result;
  }

  policy() {
    const settings = this.store.db.settings;
    return { retentionDays: retentionDays(settings.galleryRetentionDays ?? 3), version: settings.galleryRetentionVersion || 0, lastCleanup: settings.galleryLastCleanup || null };
  }

  owner(token) {
    const key = String(token || '');
    const user = this.store.db.users.find(item => item.token === key);
    return { keyId: ownerId(key), name: user?.memberAuth?.username || user?.note || (user ? user.id : key ? '已删除成员 / 历史 Key' : '未知 Key'), maskedKey: key ? key.length < 12 ? '••••' : `${key.slice(0, 7)}…${key.slice(-4)}` : '未记录', deletedMember: !user };
  }

  tokenFor(keyId) {
    if (typeof keyId !== 'string' || !/^[a-f0-9]{32}$/.test(keyId)) error(400, 'Key 筛选无效');
    const tokens = this.store.sqlite.prepare("SELECT COALESCE(token, '') AS token FROM images GROUP BY token UNION SELECT COALESCE(token, '') FROM users").all();
    const item = tokens.find(row => ownerId(row.token) === keyId);
    if (!item) error(400, 'Key 不存在，请刷新列表');
    return item.token;
  }

  where(filters = {}, days = this.policy().retentionDays) {
    const clauses = [imageTypes];
    const params = {};
    if (filters.keyId) { clauses.push("COALESCE(token, '') = @token"); params.token = this.tokenFor(filters.keyId); }
    for (const name of ['from', 'before']) {
      if (!filters[name]) continue;
      if (typeof filters[name] !== 'string' || !Number.isFinite(Date.parse(filters[name]))) error(400, '日期筛选无效');
      params[name] = new Date(filters[name]).toISOString();
      clauses.push(`created_at ${name === 'from' ? '>=' : '<'} @${name}`);
    }
    if (params.from && params.before && params.from >= params.before) error(400, '开始时间须早于结束时间');
    if (filters.expiredOnly === true || filters.expiredOnly === 'true') {
      if (!days) clauses.push('0');
      else { clauses.push('created_at < @expires'); params.expires = new Date(this.now() - days * DAY).toISOString(); }
    }
    return { sql: clauses.join(' AND '), params };
  }

  async fileInfo(image) {
    if (!image.file) return { bytes: 0, missing: true };
    const file = String(image.file).replaceAll('\\', '/');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(image.id) || !new RegExp(`^images/${image.id}\\.(png|jpe?g|webp)$`, 'i').test(file)) error(409, '图片路径异常，已跳过');
    let directory;
    try { directory = await lstat(this.imageDir); }
    catch (cause) { if (cause.code === 'ENOENT') return { bytes: 0, missing: true }; throw cause; }
    if (!directory.isDirectory() || directory.isSymbolicLink()) error(409, '图片目录异常，已跳过');
    const filename = path.join(this.imageDir, file.slice(7));
    try {
      const stats = await lstat(filename);
      if (!stats.isFile() || stats.isSymbolicLink()) error(409, '图片文件异常，已跳过');
      return { filename, bytes: stats.size, missing: false };
    } catch (cause) {
      if (cause.code === 'ENOENT') return { filename, bytes: 0, missing: true };
      throw cause;
    }
  }

  async scan(sql, params, consume) {
    let cursor = '';
    while (true) {
      const rows = this.store.sqlite.prepare(`SELECT ${fields} FROM images WHERE ${sql} AND id > @cursor ORDER BY id LIMIT 100`).all({ ...params, cursor });
      if (!rows.length) break;
      for (let offset = 0; offset < rows.length; offset += 8) {
        const items = await Promise.all(rows.slice(offset, offset + 8).map(async row => {
          try { return { ...row, ...await this.fileInfo(row) }; }
          catch { return { ...row, bytes: 0, unreadable: true }; }
        }));
        for (const item of items) consume(item);
      }
      cursor = rows.at(-1).id;
    }
  }

  async summary() {
    await this.store.queue.catch(() => {});
    this.store.flushPendingPersistSync();
    const policy = this.policy();
    const groups = new Map();
    const cutoff = policy.retentionDays ? new Date(this.now() - policy.retentionDays * DAY).toISOString() : '';
    const addOwner = token => {
      const id = ownerId(token);
      if (!groups.has(id)) groups.set(id, { ...this.owner(token), count: 0, bytes: 0, expired: 0, missing: 0, unreadable: 0 });
      return groups.get(id);
    };
    for (const user of this.store.db.users) addOwner(user.token);
    const upper = this.store.sqlite.prepare('SELECT MAX(rowid) AS n FROM images').get().n || 0;
    await this.scan(`${imageTypes} AND rowid <= @upper`, { upper }, image => {
      const group = addOwner(image.token);
      group.count++; group.bytes += image.bytes;
      group.expired += Number(Boolean(cutoff && image.createdAt && image.createdAt < cutoff));
      group.missing += Number(Boolean(image.missing)); group.unreadable += Number(Boolean(image.unreadable));
    });
    const keys = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.keyId.localeCompare(b.keyId));
    const totals = { count: 0, bytes: 0, expired: 0, missing: 0, unreadable: 0 };
    for (const key of keys) for (const field of Object.keys(totals)) totals[field] += key[field];
    return { ...policy, ...totals, keys };
  }

  async page(filters = {}) {
    await this.store.queue.catch(() => {});
    this.store.flushPendingPersistSync();
    const offset = Number(filters.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) error(400, '分页无效');
    const { sql, params } = this.where(filters);
    const total = this.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM images WHERE ${sql}`).get(params).n;
    const rows = this.store.sqlite.prepare(`SELECT id, data FROM images WHERE ${sql} ORDER BY order_value DESC LIMIT 24 OFFSET @offset`).all({ ...params, offset });
    const images = await Promise.all(rows.map(async row => {
      const image = JSON.parse(row.data);
      let file; try { file = await this.fileInfo(image); } catch { file = { bytes: 0, unreadable: true }; }
      return { id: row.id, filename: path.posix.basename(String(image.file || row.id).replaceAll('\\', '/')), ...this.owner(image.token), createdAt: image.createdAt, prompt: image.fullPrompt || image.prompt || '', model: image.model,
        width: image.width, height: image.height, steps: image.routedSteps ?? image.requestedSteps, cost: image.cost, mimeType: image.mimeType,
        bytes: file.bytes, missing: file.missing === true, unreadable: file.unreadable === true };
    }));
    return { images, total, offset, limit: 24 };
  }

  prunePlans() {
    for (const [id, plan] of this.plans) if (plan.expires <= this.now()) {
      this.plans.delete(id); this.store.sqlite.prepare('DELETE FROM gallery_cleanup_targets WHERE plan_id = ?').run(id);
    }
  }

  async createPlan(body, automatic = false) {
    await this.store.queue.catch(() => {});
    this.store.flushPendingPersistSync();
    this.prunePlans();
    if (this.plans.size >= 8) error(429, '预览过多，请关闭旧预览或稍后再试');
    const policy = body.action === 'preview-policy';
    const days = policy ? retentionDays(body.retentionDays) : this.policy().retentionDays;
    const params = {};
    let sql;
    if (policy || automatic) {
      const where = this.where({ expiredOnly: true }, days); sql = where.sql; Object.assign(params, where.params);
    } else if (body.mode === 'selected') {
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100 || body.ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) error(400, '请选择 1–100 张图片');
      const ids = [...new Set(body.ids)];
      sql = `${imageTypes} AND id IN (${ids.map((id, i) => { params[`id${i}`] = id; return `@id${i}`; }).join(',')})`;
    } else if (body.mode === 'filtered') {
      const filters = body.filters || {};
      if (!filters.keyId && !filters.from && !filters.before && filters.expiredOnly !== true) error(400, '批量清理须指定 Key、时间范围或仅过期图片');
      const where = this.where(filters); sql = where.sql; Object.assign(params, where.params);
    } else error(400, '清理范围无效');
    const id = randomBytes(24).toString('hex');
    this.store.sqlite.prepare(`INSERT INTO gallery_cleanup_targets SELECT @planId, id FROM images WHERE ${sql}`).run({ ...params, planId: id });
    const plan = { id, kind: policy ? 'policy' : 'delete', source: automatic ? 'automatic' : 'manual', retentionDays: days,
      version: this.policy().version, expires: this.now() + PLAN_TTL, total: 0, bytes: 0, keys: [], deleted: 0, freedBytes: 0, pendingBytes: 0, missing: 0, failed: 0, done: false };
    this.plans.set(id, plan);
    if (automatic) {
      plan.total = this.store.sqlite.prepare('SELECT COUNT(*) AS n FROM gallery_cleanup_targets WHERE plan_id = ?').get(id).n;
      return plan;
    }
    const keys = new Map();
    await this.scan('id IN (SELECT image_id FROM gallery_cleanup_targets WHERE plan_id = @planId)', { planId: id }, image => {
      const key = this.owner(image.token);
      if (!keys.has(key.keyId)) keys.set(key.keyId, { ...key, count: 0, bytes: 0 });
      const group = keys.get(key.keyId); group.count++; group.bytes += image.bytes;
      plan.total++; plan.bytes += image.bytes;
    });
    plan.keys = [...keys.values()];
    return this.planResult(plan);
  }

  planResult(plan) {
    const remaining = this.store.sqlite.prepare('SELECT COUNT(*) AS n FROM gallery_cleanup_targets WHERE plan_id = ?').get(plan.id).n;
    return { planId: plan.id, expiresAt: new Date(plan.expires).toISOString(), total: plan.total, bytes: plan.bytes, keys: plan.keys,
      retentionDays: plan.retentionDays, deleted: plan.deleted, freedBytes: plan.freedBytes, missing: plan.missing, failed: plan.failed, remaining, done: plan.done };
  }

  getPlan(id, kind) {
    this.prunePlans();
    const plan = this.plans.get(id);
    if (!plan || plan.kind !== kind) error(409, '预览已过期或服务已重启，请重新预览');
    return plan;
  }

  async savePolicy(id) {
    const plan = this.getPlan(id, 'policy');
    await this.store.update(db => {
      if ((db.settings.galleryRetentionVersion || 0) !== plan.version) error(409, '保存期限已变化，请重新预览');
      db.settings.galleryRetentionDays = plan.retentionDays;
      db.settings.galleryRetentionVersion = plan.version + 1;
    }, { collections: ['settings'], immediate: true });
    this.cancelPlan(id);
    if (this.started) this.schedule(1000);
    return this.policy();
  }

  cancelPlan(id) {
    this.plans.delete(id);
    this.store.sqlite.prepare('DELETE FROM gallery_cleanup_targets WHERE plan_id = ?').run(String(id || ''));
    return { cancelled: true };
  }

  async deleteBatch(id) {
    const plan = this.getPlan(id, 'delete');
    if (plan.done) return this.planResult(plan);
    // 活跃计划在每个批次续期；断开后不会继续发起人工清理。
    plan.expires = this.now() + PLAN_TTL;
    await this.store.update(async () => {
      const rows = this.store.sqlite.prepare(`SELECT ${fields} FROM images WHERE id IN
        (SELECT image_id FROM gallery_cleanup_targets WHERE plan_id = ?) ORDER BY id LIMIT ?`).all(id, BATCH);
      const removed = []; let freed = 0;
      for (const image of rows) {
        let ready = false;
        try {
          if (plan.source === 'automatic') {
            const days = this.policy().retentionDays;
            if (!days || !image.createdAt || image.createdAt >= new Date(this.now() - days * DAY).toISOString()) continue;
          }
          if (this.store.sqlite.prepare("SELECT 1 FROM jobs WHERE image_id = ? AND status IN ('queued', 'running') LIMIT 1").get(image.id)) { plan.failed++; continue; }
          const file = await this.fileInfo(image);
          if (!file.missing) {
            try { await this.removeFile(file.filename); freed += file.bytes; }
            catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
          } else plan.missing++;
          removed.push(image.id);
          ready = true;
        } catch { plan.failed++; }
        finally { if (!ready) this.store.sqlite.prepare('DELETE FROM gallery_cleanup_targets WHERE plan_id = ? AND image_id = ?').run(id, image.id); }
      }
      plan.freedBytes += freed; plan.pendingBytes += freed;
      try { this.store.deleteGalleryImageRecords(removed, { source: plan.source, bytes: plan.pendingBytes, at: new Date(this.now()).toISOString() }); }
      catch { error(500, '图片索引更新失败；请重试本次清理，以完成文件与索引同步'); }
      plan.pendingBytes = 0; plan.deleted += removed.length;
      for (const imageId of removed) this.store.sqlite.prepare('DELETE FROM gallery_cleanup_targets WHERE plan_id = ? AND image_id = ?').run(id, imageId);
      // 其他清理计划可能已移除同一批图片。
      this.store.sqlite.prepare('DELETE FROM gallery_cleanup_targets WHERE plan_id = ? AND image_id NOT IN (SELECT id FROM images)').run(id);
      plan.done = !this.store.sqlite.prepare('SELECT 1 FROM gallery_cleanup_targets WHERE plan_id = ? LIMIT 1').get(id);
    }, { persist: false });
    if (plan.done) await this.store.update(db => {
      db.settings.galleryLastCleanup = { at: new Date(this.now()).toISOString(), source: plan.source, deleted: plan.deleted, bytes: plan.freedBytes, missing: plan.missing, failed: plan.failed };
    }, { collections: ['settings'], immediate: true });
    return this.planResult(plan);
  }

  async content(id, req, res) {
    const image = await this.store.findImage(id);
    if (!image || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType || 'image/png')) error(404, '图片不存在或已清理');
    const file = await this.fileInfo(image);
    if (file.missing) error(404, '图片文件不存在或已清理');
    let handle;
    try { handle = await open(file.filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
    catch (cause) { if (cause.code === 'ENOENT') error(404, '图片文件不存在或已清理'); throw cause; }
    try {
      const stats = await handle.stat();
      res.writeHead(200, { 'content-type': image.mimeType || 'image/png', 'content-length': stats.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
      if (req.method === 'HEAD') res.end();
      else {
        try { await pipeline(handle.createReadStream({ autoClose: false }), res); }
        catch (cause) { if (!res.destroyed) res.destroy(cause); }
      }
    } finally { await handle.close(); }
  }

  async handle(req, res, url, { assertAdmin }) {
    if (url.pathname !== '/api/admin/gallery' && !url.pathname.startsWith('/api/admin/gallery/')) return false;
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host || ''))) error(404, 'not found.');
    sameOrigin(req);
    assertAdmin(req, url);
    const content = /^\/api\/admin\/gallery\/images\/([a-zA-Z0-9_-]{1,128})\/content$/.exec(url.pathname);
    if (content && ['GET', 'HEAD'].includes(req.method)) await this.content(content[1], req, res);
    else if (url.pathname !== '/api/admin/gallery') error(404, 'not found.');
    else if (req.method === 'GET') {
      const filters = Object.fromEntries(url.searchParams);
      reply(res, await this.locked(() => filters.view === 'summary' ? this.summary() : this.page(filters)));
    } else if (req.method === 'POST') {
      const body = await json(req);
      const result = await this.locked(() => {
        if (['preview-delete', 'preview-policy'].includes(body.action)) return this.createPlan(body);
        if (body.action === 'delete') return this.deleteBatch(body.planId);
        if (body.action === 'save-policy') return this.savePolicy(body.planId);
        if (body.action === 'cancel') return this.cancelPlan(body.planId);
        error(400, '图库操作无效');
      });
      reply(res, result);
    } else error(405, 'method not allowed');
    return true;
  }

  async runExpired() {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      if (!this.policy().retentionDays) return;
      const plan = await this.locked(() => this.createPlan({}, true));
      try {
        while (!plan.done && !this.stopping) {
          await this.locked(() => this.deleteBatch(plan.id));
          await new Promise(resolve => setImmediate(resolve));
        }
      } finally { await this.locked(() => this.cancelPlan(plan.id)); }
    })();
    try { return await this.sweeping; } finally { this.sweeping = null; }
  }

  schedule(delay = 3600000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.runExpired().catch(() => console.error('[gallery] 自动清理失败，下次检查重试')).finally(() => { if (this.started) this.schedule(); });
    }, delay);
    this.timer.unref();
  }

  start() { this.started = true; this.stopping = false; this.schedule(60000); }
  stop() { this.started = false; this.stopping = true; clearTimeout(this.timer); return Promise.allSettled([this.work, this.sweeping].filter(Boolean)); }
}
