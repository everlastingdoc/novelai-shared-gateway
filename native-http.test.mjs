import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { bootstrap } from './scripts/bootstrap.mjs';
import { JsonStore } from './server/store.js';
import { syncFairQuota, quoteFairRequest } from './server/fair-quota.js';
import { parseNativeImageRequest } from './server/native-image.js';
import { nativeImagesMsgpack } from './server/native-stream.js';
import { readNativeEvents } from './test-support/native-stream-client.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
// 合成图片和新建临时数据库；测试不会读取 .env、生产数据或请求真实 NAI。
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
const body = (model = 'nai-diffusion-5-full', extra = {}) => ({
  input: 'a small blue paper boat', model, action: 'generate',
  parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1, seed: 7, ...extra }
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('独立公开发行版从初始化到真实 HTTP 返回、扣费、退款与重启', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'nai-gateway-compat-'));
  const adminToken = randomBytes(32).toString('hex');
  const upstreamToken = 'pst-synthetic-offline-fixture-only';
  const initialized = await bootstrap({ env: { ADMIN_TOKEN: adminToken, NOVELAI_TOKEN: upstreamToken, DATA_DIR: dataDir }, log() {} });
  const credentials = JSON.parse(await readFile(initialized.credentialPath, 'utf8')).accounts;
  const originalNewKey = credentials[0].api_key;
  credentials[1].api_key = 'LEGACY-synthetic-active';
  credentials[2].api_key = 'LEGACY-synthetic-disabled';
  credentials[3].api_key = 'pst-synthetic-recorded';
  const seeded = new JsonStore(dataDir);
  await seeded.init();
  try {
    await seeded.update(db => {
      // 保留合成旧凭据，验证升级不依赖固定前缀，也不接受误登记的官方凭据。
      for (const member of credentials) db.users.find(user => user.id === member.user_id).token = member.api_key;
      db.users.find(user => user.id === credentials[2].user_id).enabled = false;
      Object.assign(db.accounts[0], { quotaTier: 3, subscriptionActive: true, subscriptionExpiresAt: Date.now() + 86400000,
        quotaPoints: 10000, quotaFixed: 10000, quotaPurchased: 0, v5UsagePercent: 100,
        v5UsageIsNegative: false, v5UsageTimeUntilNextPercent: 0, quotaCheckedAt: new Date().toISOString(), upstreamStatus: 'active' });
      syncFairQuota(db);
    }, { collections: ['users', 'accounts', 'settings'], includeSettings: true, immediate: true });
  } finally { await seeded.close(); }

  const calls = [];
  let failAt = -1, failStatus = 500, officialFixed = 10000, officialV5 = 100;
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${upstreamToken}`);
    assert.equal(req.headers['user-agent'], 'Mozilla/5.0 NovelAISharedGateway/1.0');
    if (req.url === '/user/data') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ subscription: { tier: 3, active: true, expiresAt: Math.floor(Date.now() / 1000) + 86400,
        trainingStepsLeft: { fixedTrainingStepsLeft: officialFixed, purchasedTrainingSteps: 0 },
        usage: { percent: officialV5, isNegative: false, timeUntilNextPercent: 0 } } }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ pathname: req.url, payload });
    if (calls.length === failAt) {
      res.writeHead(failStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: failStatus === 429 ? 'Concurrent generation limit reached' : 'synthetic generation failure' }));
      return;
    }
    const cost = quoteFairRequest(parseNativeImageRequest({ input: payload.input, action: payload.action, model: payload.model, parameters: payload.parameters }));
    if (cost.resource === 'anlas') officialFixed -= cost.amount;
    if (cost.resource === 'v5') officialV5 -= cost.amount;
    const stream = req.url.endsWith('-stream');
    res.writeHead(200, { 'content-type': stream ? 'application/octet-stream' : 'image/png' });
    res.end(stream ? nativeImagesMsgpack([png]) : png);
  });
  const upstreamPort = await listen(upstream);
  const reservation = http.createServer();
  const gatewayPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  Object.assign(env, { ADMIN_TOKEN: adminToken, DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(gatewayPort),
    NOVELAI_API_URL: `http://127.0.0.1:${upstreamPort}`, NOVELAI_ACCOUNT_API_URL: `http://127.0.0.1:${upstreamPort}`,
    PUBLIC_BASE_URL: 'https://gateway.example:8443', PUBLIC_HOST: 'gateway.example:8443', PUBLIC_HOST_ALIASES: 'gateway.example' });
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let runtimeOutput = '';
  const record = chunk => { runtimeOutput = (runtimeOutput + chunk.toString('utf8')).slice(-8000); };
  child.stdout.on('data', record); child.stderr.on('data', record);
  const stopped = once(child, 'exit');
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await stopped; };
  t.after(async () => {
    await stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    // 保留这次隔离生成的临时文件，便于复核，不执行批量删除。
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('公开版启动超时：' + runtimeOutput)), 15000);
    const ready = chunk => { if (chunk.toString().includes('NovelAI Shared Gateway listening')) { clearTimeout(timer); child.stdout.off('data', ready); resolve(); } };
    child.stdout.on('data', ready);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`公开版提前退出 ${code}：${runtimeOutput}`)); });
  });
  const fetchLocal = (pathname, options = {}) => fetch(baseUrl + pathname, { ...options, signal: AbortSignal.timeout(15000) });
  const post = (pathname, request, key = credentials[0].api_key) => fetchLocal(pathname, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(request)
  });
  const cookies = [];
  for (const member of credentials.slice(0, 2)) {
    const response = await fetchLocal('/api/member/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ username: member.username, password: member.password }) });
    assert.equal(response.status, 200);
    cookies.push(response.headers.get('set-cookie').split(';')[0]);
  }
  const quota = async (member = 0) => {
    const response = await fetchLocal('/api/member/me', { headers: { cookie: cookies[member] } });
    assert.equal(response.status, 200); return (await response.json()).quota;
  };

  await t.test('路径、鉴权与跨域校验在生图前完成，私有站点业务不存在', async () => {
    for (const pathname of ['/ai/generate-image-stream', '/v1/ai/generate-image-stream']) {
      assert.equal((await post(pathname, body(), 'invalid')).status, 401);
      assert.equal((await post(pathname, body('invalid-model'))).status, 422);
    }
    assert.equal(calls.length, 0);
    for (const pathname of ['/discord', '/auth/discord/callback', '/api/carpool/teams']) assert.equal((await fetchLocal(pathname)).status, 404);
    const cors = await new Promise((resolve, reject) => {
      const request = http.request(new URL('/ai/generate-image-stream', baseUrl), { method: 'OPTIONS', headers: { host: 'gateway.example', origin: 'https://client.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,idempotency-key' } }, response => {
        response.resume(); response.on('end', () => resolve(response));
      });
      request.on('error', reject); request.end();
    });
    assert.equal(cors.statusCode, 204); assert.equal(cors.headers['access-control-allow-origin'], '*');
    assert.match(cors.headers['access-control-allow-headers'], /idempotency-key/);
  });

  await t.test('新旧登记 Key 经真实 HTTP 精确鉴权，禁用、未知、改前缀和官方 Key 均被拒绝', async () => {
    assert.match(originalNewKey, /^NAI-/);
    for (const key of [originalNewKey, credentials[1].api_key]) {
      const models = await fetchLocal('/v1/models', { headers: { authorization: `Bearer ${key}` } });
      assert.equal(models.status, 200);
      assert.ok((await models.json()).data.every(model => model.owned_by === 'novelai-shared-gateway'));
      for (const pathname of ['/ai/generate-image', '/ai/generate-image-stream', '/ai/encode-vibe']) {
        const invalidBody = await post(pathname, body('invalid-model'), key);
        assert.ok([400, 422].includes(invalidBody.status), `${pathname}: ${invalidBody.status}`);
      }
    }
    for (const key of [credentials[2].api_key, credentials[3].api_key, 'OTHER-synthetic-active', originalNewKey + 'invalid']) {
      assert.equal((await fetchLocal('/v1/models', { headers: { authorization: `Bearer ${key}` } })).status, 401);
      for (const pathname of ['/ai/generate-image', '/ai/generate-image-stream', '/ai/encode-vibe']) {
        assert.equal((await post(pathname, body(), key)).status, 401);
      }
    }
    assert.equal(calls.length, 0);
    const before = await quota(1);
    const generated = await post('/ai/generate-image', body('nai-diffusion-4-5-full'), credentials[1].api_key);
    assert.equal(generated.status, 200);
    assert.match(generated.headers.get('content-type'), /application\/zip/);
    near((await quota(1)).v5Available, before.v5Available);
  });

  await t.test('8443 反代 Host 支持成员登录与 Native 生图，其他端口和公网管理仍被拒绝', async () => {
    const publicOrigin = 'https://gateway.example:8443';
    const requestPublic = (pathname, { method = 'GET', headers = {}, payload } = {}) => new Promise((resolve, reject) => {
      const request = http.request(baseUrl + pathname, { method, headers: { host: 'gateway.example:8443', origin: publicOrigin, ...headers } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(15000, () => request.destroy(new Error('8443 request timeout')));
      request.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
    const login = await requestPublic('/api/member/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      payload: { username: credentials[0].username, password: credentials[0].password } });
    assert.equal(login.status, 200);
    assert.match(login.headers['set-cookie'][0], /; Secure/);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const key = await requestPublic('/api/member/key', { headers: { cookie } });
    assert.equal(key.status, 200);
    assert.deepEqual(JSON.parse(key.body), { apiKey: credentials[0].api_key, baseUrl: `${publicOrigin}/v1` });
    assert.equal((await requestPublic('/api/member/key', { headers: { cookie, origin: 'https://gateway.example' } })).status, 403);
    assert.equal((await requestPublic('/api/member/me', { headers: { cookie, host: 'gateway.example:9443' } })).status, 403);
    for (const pathname of ['/admin', '/api/admin/member-management', '/api/admin/summary', '/api/admin/gallery', '/api/admin/gallery/images/img_unknown/content']) {
      assert.equal((await requestPublic(pathname, { headers: { 'x-admin-token': adminToken } })).status, 404);
    }
    const generated = await requestPublic('/ai/generate-image-stream', { method: 'POST',
      headers: { authorization: `Bearer ${credentials[0].api_key}`, 'content-type': 'application/json', origin: 'https://client.example' }, payload: body() });
    assert.equal(generated.status, 200);
    const [event] = readNativeEvents(generated.body);
    assert.equal(event.event_type, 'final');
    assert.deepEqual(Buffer.from(event.image), png);
    assert.equal(calls.at(-1).payload.parameters.steps, 23);
  });

  await t.test('Full、5C 与 Medium 从两个流式路径返回可解码最终图，按实际参数只扣本人', async () => {
    for (const [model, pathname] of [['nai-diffusion-5-full', '/ai/generate-image-stream'], ['nai-diffusion-5-curated', '/v1/ai/generate-image-stream'], ['nai-diffusion-5-full-medium', '/ai/generate-image-stream']]) {
      const input = body(model), before = await quota(), other = await quota(1);
      const response = await post(pathname, input);
      assert.equal(response.status, 200, await response.clone().text());
      assert.match(response.headers.get('content-type'), /application\/octet-stream/);
      const [event] = readNativeEvents(Buffer.from(await response.arrayBuffer()));
      assert.equal(event.event_type, 'final'); assert.equal(event.samp_ix, 0); assert.deepEqual(Buffer.from(event.image), png);
      const cost = quoteFairRequest(parseNativeImageRequest(input));
      near(before.v5Available - (await quota()).v5Available, cost.amount);
      assert.equal((await quota()).anlasFixedAvailable, before.anlasFixedAvailable);
      const unchanged = await quota(1);
      for (const field of ['v5Available', 'v5Capacity', 'v5Reserved', 'anlasFixedAvailable', 'anlasPurchasedAvailable', 'anlasReserved', 'share']) assert.equal(unchanged[field], other[field], field);
      assert.equal(calls.at(-1).payload.model, model);
      assert.equal(calls.at(-1).payload.parameters.steps, model.endsWith('-medium') ? 14 : 23);
    }
  });

  await t.test('桌面客户端 multipart 别名与普通 ZIP 接口兼容', async () => {
    const input = body('nai-diffusion-4-5-full', { uc_preset: 0, quality_toggle: false });
    const form = new FormData(); form.append('request', new Blob([JSON.stringify(input)], { type: 'application/json' }), 'request.json');
    const before = await quota();
    const response = await fetchLocal('/v1/ai/generate-image', { method: 'POST', headers: { authorization: `Bearer ${credentials[0].api_key}` }, body: form });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/zip/);
    assert.equal(Buffer.from(await response.arrayBuffer()).readUInt32LE(0), 0x04034b50);
    assert.equal(calls.at(-1).payload.parameters.ucPreset, 0); assert.equal(calls.at(-1).payload.parameters.qualityToggle, false);
    assert.equal(calls.at(-1).payload.parameters.uc_preset, undefined); assert.equal((await quota()).anlasFixedAvailable, before.anlasFixedAvailable);
  });

  await t.test('单图失败退款，多图部分成功只结算完成张并保留错误帧', async () => {
    let before = await quota(); failAt = calls.length + 1;
    const failed = await post('/ai/generate-image-stream', body());
    assert.equal(failed.status, 500); near((await quota()).v5Available, before.v5Available);
    before = await quota(); failAt = calls.length + 2;
    const response = await post('/v1/ai/generate-image-stream', body('nai-diffusion-5-curated', { steps: 29, n_samples: 3 }));
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-nai-partial'), 'true'); assert.equal(response.headers.get('x-nai-image-count'), '1');
    const events = readNativeEvents(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual(events.map(event => event.event_type), ['final', 'error']); assert.equal(events[1].samp_ix, 1);
    assert.equal(before.anlasFixedAvailable - (await quota()).anlasFixedAvailable, 32);
    assert.equal(calls.length, failAt);
  });

  await t.test('上游并发锁返回 429 与重试时间，预扣退回且不自动重发', async () => {
    const before = await quota(); failStatus = 429; failAt = calls.length + 1;
    const response = await post('/ai/generate-image-stream', body());
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '30');
    near((await quota()).v5Available, before.v5Available);
    assert.equal(calls.length, failAt);
  });

  await t.test('真实网关图库仅管理员可用，图片核对归属，签名取图与清理后的历史保持一致', async () => {
    const headers = { 'x-admin-token': adminToken, origin: baseUrl, 'content-type': 'application/json' };
    for (const denied of [{}, { cookie: cookies[0] }, { authorization: `Bearer ${credentials[0].api_key}` }]) {
      assert.equal((await fetchLocal('/api/admin/gallery?view=summary', { headers: denied })).status, 403);
    }
    const summary = await (await fetchLocal('/api/admin/gallery?view=summary', { headers })).json();
    assert.equal(summary.retentionDays, 3); assert.ok(summary.count >= 2);
    const me = await (await fetchLocal('/api/member/me', { headers: { cookie: cookies[0] } })).json();
    const job = me.jobs.find(job => job.status === 'done');
    const jobData = await (await fetchLocal(`/api/jobs/${job.id}`, { headers: { authorization: `Bearer ${credentials[0].api_key}` } })).json();
    const imagePath = `/api/images/${jobData.imageId}/content`;
    assert.equal((await fetchLocal(imagePath, { headers: { authorization: `Bearer ${credentials[1].api_key}` } })).status, 403);
    assert.deepEqual(Buffer.from(await (await fetchLocal(imagePath, { headers: { authorization: `Bearer ${credentials[0].api_key}` } })).arrayBuffer()), png);
    assert.deepEqual(Buffer.from(await (await fetchLocal(jobData.imageUrl)).arrayBuffer()), png);
    const adminContent = await fetchLocal(`/api/admin/gallery/images/${jobData.imageId}/content`, { headers });
    assert.equal(adminContent.status, 200); assert.equal(adminContent.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await adminContent.arrayBuffer()), png);
    const before = await quota();
    const preview = await (await fetchLocal('/api/admin/gallery', { method: 'POST', headers,
      body: JSON.stringify({ action: 'preview-delete', mode: 'selected', ids: [jobData.imageId] }) })).json();
    assert.equal(preview.total, 1);
    const removed = await fetchLocal('/api/admin/gallery', { method: 'POST', headers, body: JSON.stringify({ action: 'delete', planId: preview.planId }) });
    assert.equal(removed.status, 200); assert.equal((await removed.json()).deleted, 1);
    assert.deepEqual(await quota(), before);
    assert.equal((await fetchLocal(`/api/jobs/${job.id}/content`, { headers: { authorization: `Bearer ${credentials[0].api_key}` } })).status, 404);
    const history = await (await fetchLocal(`/api/jobs/${job.id}`, { headers: { authorization: `Bearer ${credentials[0].api_key}` } })).json();
    assert.equal(history.status, 'done'); assert.equal(history.imageId, '');
    assert.equal((await fetchLocal(jobData.imageUrl)).status, 404);
  });

  await stop();
  const persisted = new JsonStore(dataDir);
  await persisted.init();
  try {
    const snapshot = await persisted.readCollections(['accounts', 'jobs', 'settings']);
    assert.equal(snapshot.accounts[0].capacityConcurrencyLimit, 1);
    const reservations = Object.values(snapshot.settings.fairQuota.reservations);
    assert.ok(reservations.some(charge => charge.status === 'settled'));
    assert.ok(reservations.some(charge => charge.status === 'refunded'));
    assert.ok(reservations.every(charge => charge.status !== 'reserved'));
    assert.ok(snapshot.jobs.every(job => ['done', 'failed'].includes(job.status)));
  } finally { await persisted.close(); }
});
