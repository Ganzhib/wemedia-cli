import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createZhihuPlatform, zhihuProfile } from '../../src/platform/zhihu/adapter.js';
import { AccountRepository } from '../../src/runtime/accounts.js';
import { PlatformRegistry } from '../../src/core/registry.js';
import { PublishingService } from '../../src/services/publishing.js';

async function zhihuFixture(t: TestContext, saveDelay = 0) {
  const home = await mkdtemp(join(tmpdir(), 'wm-zhihu-')); t.after(() => rm(home, { recursive: true, force: true }));
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext();
  const remote = { id: '123456', title: '', content: '', state: 'draft', image_url: '', topics: [], column: [], creationStatement: null, author: { id: 'immutable-id' } };
  const counts = { creates: 0, saves: 0, publishes: 0, uploads: 0 }; let handle = 'mutable-handle';
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname === '/api/v4/me') return route.fulfill({ json: { id: 'immutable-id', name: '知乎作者', url_token: handle } });
    if (url.pathname.includes('/api/v4/members/')) return route.fulfill({ json: { data: [{ id: remote.id, title: remote.title }] } });
    if (url.hostname === 'api.zhihu.com' && url.pathname === '/images/7') { counts.uploads++; return route.fulfill({ json: { original_src: 'https://pic.zhimg.com/v2-fixture.jpg', src: 'https://pic.zhimg.com/v2-fixture.jpg' }, headers: { 'Access-Control-Allow-Origin': '*' } }); }
    if (url.hostname === 'pic.zhimg.com') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVJkAAAAASUVORK5CYII=', 'base64') });
    if (url.pathname === '/api/articles/drafts') { counts.creates++; remote.title = JSON.parse(request.postData()!).title; return route.fulfill({ json: { id: remote.id } }); }
    if (url.pathname === '/api/articles/123456/publish') { counts.publishes++; remote.state = 'published'; return route.fulfill({ json: remote }); }
    if (/^\/api\/articles\/123456(?:\/draft)?$/.test(url.pathname)) {
      if (request.method() === 'PATCH') { counts.saves++; await new Promise(resolve => setTimeout(resolve, saveDelay)); Object.assign(remote, JSON.parse(request.postData()!)); }
      return route.fulfill({ json: remote });
    }
    if (url.pathname === '/write' || /^\/p\/123456/.test(url.pathname)) {
      const fresh = url.pathname === '/write';
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><textarea placeholder="请输入标题（最多 100 个字）"></textarea><div contenteditable="true" role="textbox"></div><input type="file" accept="image/*"><button id="publish">发布</button><script>
      const initial=${JSON.stringify(remote).replaceAll('<', '\\u003c')}; let fresh=${fresh};
      const title=document.querySelector('textarea'),body=document.querySelector('[contenteditable]'); title.value=fresh?'':initial.title;body.innerHTML=fresh?'':initial.content;
      async function save(){await fetch('/api/articles/123456/draft',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:title.value,content:body.innerHTML})});}
      title.oninput=async()=>{if(fresh){await fetch('/api/articles/drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:title.value})});fresh=false;}else await save();};
      body.addEventListener('paste',async e=>{e.preventDefault();body.innerHTML=e.clipboardData.getData('text/html');await save();});
      document.querySelector('input[type=file]').onchange=async()=>{const response=await fetch('https://api.zhihu.com/images/7');const image=await response.json();body.innerHTML+='<img src="'+image.src+'">';await save();};
      document.querySelector('#publish').onclick=async()=>{await fetch('/api/articles/123456/publish',{method:'POST'});location.href='/p/123456';};
      </script>` });
    }
    if (url.hostname.endsWith('zhihu.com')) return route.fulfill({ contentType: 'text/html', body: '<h1>知乎</h1>' });
    return route.abort();
  });
  const platform = createZhihuPlatform({ withBrowser: async (_account, action) => { const page = await context.newPage(); try { return await action(context, page); } finally { await page.close(); } } });
  const accounts = new AccountRepository(home); const binding = await accounts.login('zhihu', 'main', async () => ({ id: 'immutable-id', name: '知乎作者' }));
  const service = new PublishingService(home, new PlatformRegistry([platform]));
  const file = join(home, 'article.md'); await writeFile(file, '# 知乎文章\n\n完整正文内容，前后顺序必须保留。');
  return { home, service, remote, counts, file, binding, changeHandle: () => { handle = 'new-handle'; } };
}

test('Zhihu native draft allocation and paste save the actual server resource; mutable handles do not change account identity', async t => {
  const { service, remote, counts, file, binding, changeHandle } = await zhihuFixture(t, 200);
  changeHandle(); const result = await service.invoke('zhihu', 'main', 'draft.create', { file });
  assert.equal(result.effect, 'remote-write');
  if (result.effect === 'remote-write') { assert.equal(result.value.targets[0].status, 'draft_saved', result.value.targets[0].message); assert.equal(result.value.targets[0].identity.accountId, binding.identity.accountId); }
  assert.equal(counts.creates, 1); assert.match(remote.content, /完整正文/);
  await service.invoke('zhihu', 'main', 'draft.create', { file }); assert.equal(counts.creates, 1);
});

test('Zhihu native upload replaces the original image position and can publish the original saved draft', async t => {
  const { home, service, file, counts } = await zhihuFixture(t);
  await writeFile(join(home, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVJkAAAAASUVORK5CYII=', 'base64'));
  await writeFile(file, '# 图片位置\n\n图片之前\n\n![本地图片](./image.png)\n\n图片之后');
  const created = await service.invoke('zhihu', 'main', 'draft.create', { file });
  if (created.effect === 'remote-write') assert.equal(created.value.targets[0].status, 'draft_saved', created.value.targets[0].message);
  const snapshot = (await service.invoke('zhihu', 'main', 'resource.get', { resource: { kind: 'draft', id: '123456' } })).value;
  assert.match(JSON.stringify(snapshot), /图片之前[\s\S]*pic.zhimg.com[\s\S]*图片之后/);
  const published = await service.invoke('zhihu', 'main', 'draft.publish', { base: snapshot });
  if (published.effect === 'remote-write') assert.equal(published.value.targets[0].status, 'published', published.value.targets[0].message);
  assert.equal(counts.creates, 1); assert.equal(counts.publishes, 1); assert.equal(counts.uploads, 1);
});

test('Zhihu external edits stop same-resource publication before clicking publish', async t => {
  const { service, remote, counts } = await zhihuFixture(t);
  const base = (await service.invoke('zhihu', 'main', 'resource.get', { resource: { kind: 'draft', id: '123456' } })).value;
  remote.content = '<p>edited elsewhere</p>';
  const result = await service.invoke('zhihu', 'main', 'draft.publish', { base });
  if (result.effect === 'remote-write') { assert.equal(result.value.targets[0].requiredAction, 'review_remote_changes'); assert.equal(result.value.targets[0].failure?.code, 'CONFLICT'); }
  assert.equal(counts.publishes, 0); assert.equal(counts.creates, 0);
});


test('Zhihu login waits for actual navigation instead of treating an async predicate as authenticated', async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let reads = 0;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/signin') return route.fulfill({ contentType: 'text/html', body: '<script>setTimeout(()=>location.href="/",180)</script>' });
    if (url.pathname === '/api/v4/me') { reads++; return route.fulfill({ json: { id: 'stable', name: 'Author', url_token: 'handle' } }); }
    return route.fulfill({ contentType: 'text/html', body: '<h1>Home</h1>' });
  });
  const session = await zhihuProfile(page, true); assert.equal(session.profile.id, 'stable'); assert.equal(reads, 1);
});
