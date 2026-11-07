import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicHost, privateAccessAllowed } from './public-hosts.js';
import { handleMemberRoutes } from './member-routes.js';

const env = { PUBLIC_MODE: 'true', PUBLIC_HOST: 'old.example', PUBLIC_HOST_ALIASES: ' nai.example, nai-direct.example ' };
const request = (host, url = '/ai/user/subscription', headers = {}) => ({ method: 'GET', url, headers: { host, ...headers } });

test('公开入口仅接受启用状态下的显式主域名或别名', () => {
  for (const host of ['old.example', 'nai.example', 'nai-direct.example', 'NAI.EXAMPLE']) assert.equal(isPublicHost(host, env), true);
  for (const mode of [undefined, '', 'false', 'TRUE']) assert.equal(isPublicHost('nai.example', { ...env, PUBLIC_MODE: mode }), false);
  for (const host of ['', 'other.example', 'evil.nai.example', 'nai.example.evil', 'nai.example.', 'nai.example:443', ' nai.example', 'nai.example ', 'nai.example,evil.example', 'https://nai.example', 'nai.example/']) {
    assert.equal(isPublicHost(host, env), false, host);
  }
  assert.equal(isPublicHost(['nai.example'], env), false);
  assert.equal(isPublicHost('nai.example', { ...env, PUBLIC_HOST: '', PUBLIC_HOST_ALIASES: '*.example,https://nai.example,nai.example/path' }), false);
});

test('Host 白名单不接受转发头冒充；公开插件跨域与本机同源行为保持', () => {
  const spoof = { 'x-forwarded-host': 'nai.example', forwarded: 'host=nai.example', origin: 'https://nai.example' };
  assert.equal(privateAccessAllowed(request('evil.example', '/', spoof), env), false);
  assert.equal(privateAccessAllowed(request(undefined, '/', spoof), env), false);
  assert.equal(privateAccessAllowed(request('nai.example', '/ai/user/subscription', { origin: 'http://192.168.1.2:8000', 'sec-fetch-site': 'cross-site' }), env), true);
  assert.equal(privateAccessAllowed(request('nai-direct.example'), { ...env, PUBLIC_MODE: 'false' }), false);
  assert.equal(privateAccessAllowed(request('127.0.0.1:19080', '/admin', { origin: 'http://127.0.0.1:19080' }), env), true);
  assert.equal(privateAccessAllowed(request('localhost:19080', '/admin', { origin: 'https://evil.example' }), env), false);
  assert.equal(privateAccessAllowed(request('127.0.0.1:19080', '/admin', { 'sec-fetch-site': 'cross-site' }), env), false);
  for (const url of ['/admin', '/admin/', '/admin?view=users', '/api/admin/member-management', '/memory']) {
    assert.equal(privateAccessAllowed(request('nai.example', url, { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' }), env), false, url);
  }
});

test('公开入口支持显式端口，主域名和别名均精确匹配端口', () => {
  const portEnv = { PUBLIC_MODE: 'true', PUBLIC_HOST: 'nai.example:8443', PUBLIC_HOST_ALIASES: ' backup.example:9443 ' };
  for (const host of ['nai.example:8443', 'NAI.EXAMPLE:8443', 'backup.example:9443']) assert.equal(isPublicHost(host, portEnv), true, host);
  for (const host of ['nai.example', 'nai.example:443', 'nai.example:9443', 'backup.example', 'backup.example:8443', 'evil.nai.example:8443']) {
    assert.equal(isPublicHost(host, portEnv), false, host);
  }
  for (const host of ['nai.example:0', 'nai.example:65536', 'nai.example:08443', 'nai.example:', 'nai.example:+8443', 'nai.example:8443:1', 'https://nai.example:8443', 'user@nai.example:8443', 'nai.example:8443/path', 'nai.example:8443 ', ' nai.example:8443', 'nai.example:8443\n']) {
    assert.equal(isPublicHost(host, { PUBLIC_MODE: 'true', PUBLIC_HOST: host }), false, host);
  }
  assert.equal(isPublicHost('nai.example:65535', { ...portEnv, PUBLIC_HOST: 'nai.example:65535' }), true);
  assert.equal(privateAccessAllowed(request('nai.example:8443', '/ai/user/subscription', { origin: 'https://client.example', 'sec-fetch-site': 'cross-site' }), portEnv), true);
  assert.equal(privateAccessAllowed(request('evil.example:8443', '/', { 'x-forwarded-host': 'nai.example:8443' }), portEnv), false);
  for (const url of ['/admin', '/api/admin/member-management', '/memory']) {
    assert.equal(privateAccessAllowed(request('nai.example:8443', url, { origin: 'https://evil.example' }), portEnv), false, url);
  }
});

test('新公开别名即使同源且带管理员凭据，也不能进入成员管理路由', async () => {
  for (const host of ['old.example', 'nai.example', 'nai-direct.example', 'nai.example:8443']) {
    let adminChecked = false;
    await assert.rejects(handleMemberRoutes(request(host, '/api/admin/member-management', { origin: `https://${host}`, 'x-admin-token': 'synthetic-admin' }), {}, new URL(`https://${host}/api/admin/member-management`), {
      assertAdmin() { adminChecked = true; }
    }), { statusCode: 404 });
    assert.equal(adminChecked, false);
  }
});
