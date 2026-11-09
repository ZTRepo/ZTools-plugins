// upload-to-market.test.js —— 自建市场上传脚本行为测试
// 用 node:http mock SmartGin 管理端 API，断言创建/更新/上传/去重/分类映射逻辑
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import archiver from 'archiver';

import { uploadMarketPlugins } from './upload-to-market.js';

// ---- 工具：把文件打包成 zip（与真实 build 产物同构）----
function makeZip(files) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', c => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const [name, content] of Object.entries(files)) {
      archive.append(content, { name });
    }
    archive.finalize();
  });
}

// ---- 工具：启动 mock 管理端服务器，返回基址与收到的请求记录 ----
function startMockServer(handlers) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    let parsedBody = null;
    try { parsedBody = JSON.parse(body.toString('utf8')); } catch { /* multipart 非 JSON */ }
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      rawBody: body,
      json: parsedBody,
      isMultipart: (req.headers['content-type'] || '').includes('multipart/form-data')
    });
    const key = `${req.method} ${req.url.split('?')[0]}`;
    const handler = handlers[key] || handlers[req.method];
    if (!handler) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'A0404', msg: 'not found' })); return; }
    // handler 返回 {code,msg,data} 响应体（测试直接用 ok() 包装），原样输出为 JSON
    const out = await handler(req, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(typeof out === 'string' ? out : JSON.stringify(out));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

// 响应包装：管理端 {code,msg,data}
const ok = data => ({ code: '00000', msg: 'success', data });

function pluginJsonFixture(overrides = {}) {
  return JSON.stringify({
    name: 'demo-plugin',
    title: 'Demo 插件',
    description: '用于测试的演示插件',
    author: 'tester',
    version: '1.2.3',
    logo: 'logo.png',
    categories: ['ai'],
    ...overrides
  });
}

// ---- 测试夹具：临时 release 目录 + fixture zip ----
async function makeReleaseDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mkt-upload-'));
  mkdirSync(join(dir, 'release'), { recursive: true });
  for (const [zipName, zipContent] of Object.entries(files)) {
    writeFileSync(join(dir, 'release', zipName), zipContent);
  }
  return dir;
}

test('新插件：创建并上传版本，分类按 catKey 映射，logo 上传后写入 URL', async () => {
  const zip = await makeZip({
    'plugin.json': pluginJsonFixture(),
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47])
  });
  const dir = await makeReleaseDir({ 'demo-plugin-1.2.3.zip': zip });
  const mock = await startMockServer({
    'GET /api/v1/market/categories': () => ok([
      { id: 3, catKey: 'ai', title: 'AI' },
      { id: 5, catKey: 'tools', title: '工具' }
    ]),
    'GET /api/v1/market/plugins': () => ok({ list: [], total: 0 }),
    'POST /api/v1/market/plugins': () => ok({ id: 42 }),
    'POST /api/v1/market/plugins/42/upload': () => ok({}),
    'POST /api/v1/files': () => ok({ name: 'logo.png', url: `${mock.baseUrl}/files/logos/logo.png`, path: 'logos', size: 4 })
  });

  try {
    await uploadMarketPlugins({ baseUrl: mock.baseUrl, token: 'tkn', releaseDir: join(dir, 'release'), platform: 'win32' });

    // 分类列表已请求
    assert.ok(mock.requests.some(r => r.url === '/api/v1/market/categories' && r.method === 'GET'));
    // logo 上传
    const logoReq = mock.requests.find(r => r.url === '/api/v1/files' && r.method === 'POST' && r.isMultipart);
    assert.ok(logoReq, '应上传 logo 文件');
    // 创建请求：字段映射正确
    const createReq = mock.requests.find(r => r.method === 'POST' && r.url === '/api/v1/market/plugins');
    assert.ok(createReq, '应调用创建接口');
    assert.equal(createReq.json.name, 'demo-plugin');
    assert.equal(createReq.json.title, 'Demo 插件');
    assert.equal(createReq.json.categoryId, 3, 'ai 分类应映射到 id=3');
    assert.deepEqual(createReq.json.platforms, ['win32']);
    assert.equal(createReq.json.sourceType, 'open_source');
    assert.equal(createReq.json.enabled, 1);
    assert.equal(createReq.json.logo, `${mock.baseUrl}/files/logos/logo.png`);
    // 版本上传：携带 version + zip 文件
    const uploadReq = mock.requests.find(r => r.method === 'POST' && r.url === '/api/v1/market/plugins/42/upload' && r.isMultipart);
    assert.ok(uploadReq, '应调用版本上传接口');
    const raw = uploadReq.rawBody.toString('latin1');
    assert.ok(raw.includes('1.2.3'), '上传表单应含版本号');
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('已存在插件：更新元数据而非重复创建，并上传新版本', async () => {
  const zip = await makeZip({ 'plugin.json': pluginJsonFixture({ version: '2.0.0' }) });
  const dir = await makeReleaseDir({ 'demo-plugin-2.0.0.zip': zip });
  const mock = await startMockServer({
    'GET /api/v1/market/categories': () => ok([{ id: 3, catKey: 'ai', title: 'AI' }]),
    'GET /api/v1/market/plugins': () => ok({ list: [{ id: 9, name: 'demo-plugin', version: '1.9.0' }], total: 1 }),
    'PUT /api/v1/market/plugins/9': () => ok({}),
    'POST /api/v1/market/plugins/9/upload': () => ok({})
  });

  try {
    await uploadMarketPlugins({ baseUrl: mock.baseUrl, token: 'tkn', releaseDir: join(dir, 'release'), platform: 'linux' });
    assert.ok(!mock.requests.some(r => r.method === 'POST' && r.url === '/api/v1/market/plugins'), '已存在时不应重复创建');
    const updateReq = mock.requests.find(r => r.method === 'PUT' && r.url === '/api/v1/market/plugins/9');
    assert.ok(updateReq, '应调用更新接口');
    assert.equal(updateReq.json.version, '2.0.0');
    assert.ok(mock.requests.some(r => r.method === 'POST' && r.url === '/api/v1/market/plugins/9/upload'));
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('版本一致：跳过已发布插件，不重复上传', async () => {
  const zip = await makeZip({ 'plugin.json': pluginJsonFixture() }); // version 1.2.3
  const dir = await makeReleaseDir({ 'demo-plugin-1.2.3.zip': zip });
  const mock = await startMockServer({
    'GET /api/v1/market/categories': () => ok([{ id: 3, catKey: 'ai', title: 'AI' }]),
    'GET /api/v1/market/plugins': () => ok({ list: [{ id: 9, name: 'demo-plugin', version: '1.2.3' }], total: 1 }),
    'PUT /api/v1/market/plugins/9': () => ok({}),
    'POST /api/v1/market/plugins/9/upload': () => ok({})
  });

  try {
    await uploadMarketPlugins({ baseUrl: mock.baseUrl, token: 'tkn', releaseDir: join(dir, 'release'), platform: 'win32' });
    assert.ok(!mock.requests.some(r => r.url?.startsWith('/api/v1/market/plugins/9/upload')), '同版本不应重复上传');
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同插件多个 zip：只上传最高版本', async () => {
  const zipLow = await makeZip({ 'plugin.json': pluginJsonFixture({ version: '1.0.0' }) });
  const zipHigh = await makeZip({ 'plugin.json': pluginJsonFixture({ version: '2.5.0' }) });
  const dir = await makeReleaseDir({
    'demo-plugin-1.0.0.zip': zipLow,
    'demo-plugin-2.5.0.zip': zipHigh
  });
  const mock = await startMockServer({
    'GET /api/v1/market/categories': () => ok([{ id: 3, catKey: 'ai', title: 'AI' }]),
    'GET /api/v1/market/plugins': () => ok({ list: [], total: 0 }),
    'POST /api/v1/market/plugins': () => ok({ id: 42 }),
    'POST /api/v1/market/plugins/42/upload': () => ok({})
  });

  try {
    await uploadMarketPlugins({ baseUrl: mock.baseUrl, token: 'tkn', releaseDir: join(dir, 'release'), platform: 'win32' });
    const creates = mock.requests.filter(r => r.method === 'POST' && r.url === '/api/v1/market/plugins');
    assert.equal(creates.length, 1, '同插件应只创建一次');
    assert.equal(creates[0].json.version, '2.5.0', '应取最高版本创建');
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('分类匹配不到：回退默认分类 ID', async () => {
  const zip = await makeZip({ 'plugin.json': pluginJsonFixture({ categories: ['unknown-cat'] }) });
  const dir = await makeReleaseDir({ 'demo-plugin-1.2.3.zip': zip });
  const mock = await startMockServer({
    'GET /api/v1/market/categories': () => ok([{ id: 3, catKey: 'ai', title: 'AI' }]),
    'GET /api/v1/market/plugins': () => ok({ list: [], total: 0 }),
    'POST /api/v1/market/plugins': () => ok({ id: 42 }),
    'POST /api/v1/market/plugins/42/upload': () => ok({})
  });

  try {
    await uploadMarketPlugins({ baseUrl: mock.baseUrl, token: 'tkn', releaseDir: join(dir, 'release'), platform: 'win32', defaultCategoryId: 7 });
    const createReq = mock.requests.find(r => r.method === 'POST' && r.url === '/api/v1/market/plugins');
    assert.equal(createReq.json.categoryId, 7, '未匹配分类应回退默认 ID');
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
