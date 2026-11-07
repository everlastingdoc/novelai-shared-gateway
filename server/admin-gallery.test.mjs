import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AdminGallery } from './admin-gallery.js';
import { JsonStore } from './store.js';

// 隔离临时数据库与合成图片；不读取 .env，不连接真实上游。
process.env.NO_AUTO_DELETE = 'true';
process.env.RUNTIME_IMAGES_CACHE_LIMIT = '2';
process.env.RUNTIME_JOBS_CACHE_LIMIT = '1';
const NOW = Date.parse('2026-11-07T12:00:00Z'), DAY = 86400000;
const keyA = 'NAI-synthetic-gallery-member-alpha', keyB = 'NAI-synthetic-gallery-member-beta', oldKey = 'NAI-synthetic-deleted-member-key';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');

async function fixture(t, rows, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'nai-gallery-test-'));
  await mkdir(path.join(dataDir, 'images'));
  const store = new JsonStore(dataDir); await store.init();
  let clock = NOW;
  const images = rows.map((row, i) => ({ id: `img_test_${i}`, token: keyA, mimeType: 'image/png', createdAt: new Date(NOW - 4 * DAY).toISOString(),
    file: `images/img_test_${i}.png`, fullPrompt: 'synthetic prompt <script>literal</script>', model: 'nai-diffusion-5-full', width: 1024, height: 1024, requestedSteps: 23, routedSteps: 23, cost: 1, ...row }));
  for (const image of images) if (String(image.file).startsWith('images/')) await writeFile(path.join(dataDir, image.file), png);
  await store.update(db => {
    db.settings.fairQuota = { balances: { a: { v5Available: 12.5, anlasAvailable: 100 } }, reservations: { settled: { status: 'settled' } } };
    db.users = [{ id: 'a', token: keyA, enabled: true, memberAuth: { username: 'alpha' } }, { id: 'b', token: keyB, memberAuth: { username: 'beta' } }];
    db.images = images;
    db.jobs = images.map((image, i) => ({ id: `job_${i}`, imageId: image.id, userToken: image.token, status: 'done', cost: 1, createdAt: image.createdAt, request: { prompt: 'historical parameters', image: 'historical-reference-data' } }));
    db.ledger = [{ id: 'original_charge', type: 'charge', amount: -1, token: keyA }];
  }, { immediate: true });
  const gallery = new AdminGallery({ store, dataDir, now: () => clock, ...options }); await gallery.init();
  t.after(async () => { await gallery.stop(); await store.close(); });
  return { store, gallery, images, dataDir, advance: ms => { clock += ms; } };
}

test('图库统计和分页覆盖完整 SQLite 历史，按原 Key 分组且不返回原始 Key', async t => {
  const rows = Array.from({ length: 55 }, (_, i) => ({ token: i % 2 ? keyB : keyA, createdAt: new Date(NOW - (i % 2 ? 2 : 4) * DAY).toISOString() }));
  rows.push({ token: oldKey }, { token: oldKey, mimeType: 'application/octet-stream', file: 'images/img_encoded.bin' });
  const { store, gallery, images, dataDir } = await fixture(t, rows);
  assert.equal(store.db.images.length, 2); assert.equal(store.hasPartialCollection('images'), true);
  await unlink(path.join(dataDir, images[0].file));
  const summary = await gallery.summary();
  assert.equal(summary.retentionDays, 3); assert.equal(summary.count, 56); assert.equal(summary.missing, 1); assert.equal(summary.bytes, png.length * 55);
  assert.equal(summary.expired, 29); assert.equal(summary.keys.length, 3);
  assert.equal(summary.keys.find(key => key.name === 'alpha').count, 28);
  assert.equal(summary.keys.find(key => key.deletedMember).count, 1);
  for (const key of [keyA, keyB, oldKey]) assert.ok(!JSON.stringify(summary).includes(key));
  const a = summary.keys.find(key => key.name === 'alpha');
  const page = await gallery.page({ keyId: a.keyId });
  assert.equal(page.total, 28); assert.equal(page.images.length, 24); assert.ok(page.images.every(image => image.keyId === a.keyId));
  assert.ok(!JSON.stringify(page).includes(keyA)); assert.ok(!JSON.stringify(page).includes(dataDir));
  assert.equal((await gallery.page({ keyId: a.keyId, offset: 24 })).images.length, 4);
  assert.equal((await gallery.page({ from: new Date(NOW - 3 * DAY).toISOString(), before: new Date(NOW).toISOString() })).total, 27);
  for (const filters of [{ offset: -1 }, { offset: 0.1 }, { from: 'invalid' }, { keyId: "' OR 1=1--" }, { from: '2026-11-07', before: '2026-11-06' }]) await assert.rejects(gallery.page(filters), { statusCode: 400 });
});

test('按条件预览固定删除目标，分批清理磁盘和索引，保留历史与额度并跨重启持久化', async t => {
  const { store, gallery, images, dataDir } = await fixture(t, Array.from({ length: 55 }, () => ({})));
  const quotaBefore = structuredClone(store.db.settings.fairQuota);
  const key = (await gallery.summary()).keys.find(key => key.name === 'alpha');
  await assert.rejects(gallery.createPlan({ mode: 'filtered', filters: {} }), { statusCode: 400 });
  await assert.rejects(gallery.deleteBatch('not-previewed'), { statusCode: 409 });
  const plan = await gallery.createPlan({ mode: 'filtered', filters: { keyId: key.keyId, before: new Date(NOW - 3 * DAY).toISOString() } });
  assert.equal(plan.total, 55); assert.equal(plan.bytes, 55 * png.length);
  const late = { ...images[0], id: 'img_late', file: 'images/img_late.png' };
  await writeFile(path.join(dataDir, late.file), png);
  await store.update(db => db.images.unshift(late), { collections: ['images'], dirtyRows: () => ({ images: [late.id] }), immediate: true });
  let result = await gallery.deleteBatch(plan.planId);
  assert.equal(result.deleted, 24); assert.equal(result.remaining, 31); assert.equal(result.done, false);
  while (!result.done) result = await gallery.deleteBatch(plan.planId);
  assert.equal(result.deleted, 55); assert.equal(result.freedBytes, 55 * png.length); assert.equal(result.failed, 0);
  assert.deepEqual(await gallery.deleteBatch(plan.planId), result);
  assert.deepEqual(store.db.settings.fairQuota, quotaBefore);
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM images').get().n, 1);
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE image_id IS NULL AND status = 'done'").get().n, 55);
  const historical = await store.findJobContext('job_0'); assert.equal(historical.job.imageId, ''); assert.equal(historical.job.cost, 1); assert.equal(historical.job.request.image, 'historical-reference-data');
  assert.deepEqual(JSON.parse(store.statements.selectById.ledger.get('original_charge').data), { id: 'original_charge', type: 'charge', amount: -1, token: keyA });
  for (const image of images) await assert.rejects(stat(path.join(dataDir, image.file)), { code: 'ENOENT' });
  assert.equal((await stat(path.join(dataDir, late.file))).size, png.length);
  await store.update(db => { db.settings.afterCleanup = true; }, { collections: ['settings'], immediate: true });
  await store.close();
  const reopened = new JsonStore(dataDir); await reopened.init();
  try { assert.equal(reopened.countRecords('images'), 1); assert.equal((await reopened.findJobContext('job_0')).job.imageId, ''); assert.deepEqual(reopened.db.settings.fairQuota, quotaBefore); }
  finally { await reopened.close(); }
});

test('默认三天只清理已过期图片，边界与永久保留生效，执行中延长期限会重新检查', async t => {
  const { store, gallery, images, dataDir } = await fixture(t, [
    { createdAt: new Date(NOW - 3 * DAY - 1).toISOString() },
    { createdAt: new Date(NOW - 3 * DAY).toISOString() },
    { createdAt: new Date(NOW - DAY).toISOString() },
  ]);
  await gallery.runExpired();
  assert.equal(store.countRecords('images'), 2); await assert.rejects(stat(path.join(dataDir, images[0].file)), { code: 'ENOENT' });
  assert.equal((await stat(path.join(dataDir, images[1].file))).size, png.length);
  let plan = await gallery.createPlan({ action: 'preview-policy', retentionDays: 0 }); assert.equal(plan.total, 0);
  await gallery.savePolicy(plan.planId); assert.equal(gallery.policy().retentionDays, 0);
  assert.equal((await gallery.page({ expiredOnly: true })).total, 0);
  await gallery.runExpired(); assert.equal(store.countRecords('images'), 2);
  plan = await gallery.createPlan({ action: 'preview-policy', retentionDays: 1 }); assert.equal(plan.total, 1); await gallery.savePolicy(plan.planId);
  const auto = await gallery.createPlan({}, true);
  plan = await gallery.createPlan({ action: 'preview-policy', retentionDays: 30 }); await gallery.savePolicy(plan.planId);
  await gallery.deleteBatch(auto.id); assert.equal(store.countRecords('images'), 2);
});

test('文件删除失败、文件缺失与非法路径分别处理，失败不移除记录且绝不触及目录外文件', async t => {
  const { gallery, store, images, dataDir } = await fixture(t, [{}, {}, { file: '../outside.png' }], {
    removeFile: async filename => { if (filename.endsWith('img_test_0.png')) throw Object.assign(new Error('synthetic permission failure'), { code: 'EPERM' }); await unlink(filename); }
  });
  await writeFile(path.join(dataDir, 'outside.png'), 'outside-protected');
  await unlink(path.join(dataDir, images[1].file));
  const plan = await gallery.createPlan({ mode: 'selected', ids: images.map(image => image.id) });
  const result = await gallery.deleteBatch(plan.planId);
  assert.equal(result.deleted, 1); assert.equal(result.missing, 1); assert.equal(result.failed, 2); assert.equal(result.done, true);
  assert.equal(store.countRecords('images'), 2);
  assert.ok(await store.findImage(images[0].id)); assert.ok(await store.findImage(images[2].id));
  assert.equal(await readFile(path.join(dataDir, 'outside.png'), 'utf8'), 'outside-protected');
  assert.deepEqual(await readFile(path.join(dataDir, images[0].file)), png);
});

test('预览取消、过期、版本冲突及无效期限不会删除文件或覆盖设置', async t => {
  const { gallery, dataDir, images, advance } = await fixture(t, [{}]);
  for (const value of [-1, 0.5, 3651, '3', null]) await assert.rejects(gallery.createPlan({ action: 'preview-policy', retentionDays: value }), { statusCode: 400 });
  const cancelled = await gallery.createPlan({ mode: 'selected', ids: [images[0].id] }); gallery.cancelPlan(cancelled.planId);
  await assert.rejects(gallery.deleteBatch(cancelled.planId), { statusCode: 409 });
  const expired = await gallery.createPlan({ mode: 'selected', ids: [images[0].id] }); advance(600001);
  await assert.rejects(gallery.deleteBatch(expired.planId), { statusCode: 409 });
  const first = await gallery.createPlan({ action: 'preview-policy', retentionDays: 7 });
  const stale = await gallery.createPlan({ action: 'preview-policy', retentionDays: 1 });
  await gallery.savePolicy(first.planId); await assert.rejects(gallery.savePolicy(stale.planId), { statusCode: 409 });
  assert.equal(gallery.policy().retentionDays, 7); assert.equal((await stat(path.join(dataDir, images[0].file))).size, png.length);
});

test('文件清理后遇到数据库写入失败时，固定目标可重试并完成索引同步', async t => {
  const { gallery, store, images, dataDir } = await fixture(t, [{}]);
  const plan = await gallery.createPlan({ mode: 'selected', ids: [images[0].id] });
  const original = store.deleteGalleryImageRecords.bind(store);
  store.deleteGalleryImageRecords = () => { throw new Error('synthetic transaction failure'); };
  await assert.rejects(gallery.deleteBatch(plan.planId), { statusCode: 500 });
  assert.equal(gallery.planResult(gallery.plans.get(plan.planId)).remaining, 1);
  assert.ok(await store.findImage(images[0].id));
  await assert.rejects(stat(path.join(dataDir, images[0].file)), { code: 'ENOENT' });
  store.deleteGalleryImageRecords = original;
  const result = await gallery.deleteBatch(plan.planId);
  assert.equal(result.deleted, 1); assert.equal(result.freedBytes, png.length); assert.equal(result.done, true);
  assert.equal(await store.findImage(images[0].id), null);
});

test('图库 HTTP 列表、文件和写操作均校验私有 Host、管理员请求头和同源', async t => {
  const { gallery } = await fixture(t, [{}]);
  const admin = 'synthetic-admin-only-fixture'.repeat(2);
  const server = http.createServer(async (req, res) => {
    try {
      if (!await gallery.handle(req, res, new URL(req.url, 'http://localhost'), { assertAdmin(req) { if (req.headers['x-admin-token'] !== admin) throw Object.assign(new Error('admin required'), { statusCode: 403 }); } })) { res.writeHead(404); res.end(); }
    } catch (cause) { res.writeHead(cause.statusCode || 500); res.end(JSON.stringify({ error: cause.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function call(pathname = '?view=summary', { headers = {}, body, method = body ? 'POST' : 'GET' } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(base + '/api/admin/gallery' + pathname, { method, headers: { origin: base, 'x-admin-token': admin, 'content-type': 'application/json', ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  assert.equal((await call()).status, 200);
  for (const headers of [{ 'x-admin-token': '' }, { 'x-admin-token': '', authorization: `Bearer ${keyA}` }, { 'x-admin-token': '', cookie: 'nai_member_session=fake' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    for (const pathname of ['?view=summary', '/images/img_test_0/content']) assert.equal((await call(pathname, { headers })).status, 403);
  }
  assert.equal((await call('?adminToken=' + admin, { headers: { 'x-admin-token': '' } })).status, 403);
  assert.equal((await call('', { body: { action: 'preview-policy', retentionDays: 0 }, headers: { origin: '' } })).status, 403);
  assert.equal((await call('', { headers: { host: 'gateway.example:8443', origin: 'https://gateway.example:8443' } })).status, 404);
  const content = await call('/images/img_test_0/content'); assert.equal(content.status, 200); assert.deepEqual(content.body, png); assert.equal(content.headers['cache-control'], 'no-store');
  assert.equal((await call('/images/img_test_0/content', { method: 'HEAD' })).body.length, 0);
  const preview = await call('', { body: { action: 'preview-policy', retentionDays: 0 } });
  const save = await call('', { body: { action: 'save-policy', planId: JSON.parse(preview.body).planId } }); assert.equal(save.status, 200); assert.equal(JSON.parse(save.body).retentionDays, 0);
});
