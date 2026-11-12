import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createWechatPlatform } from '../../src/platform/wechat/adapter.js';
import { AccountRepository } from '../../src/runtime/accounts.js';
import { PlatformRegistry } from '../../src/core/registry.js';
import { ObjectStore, semanticDigest } from '../../src/runtime/objects.js';
import { PublishingService } from '../../src/services/publishing.js';

async function wechatFixture(t: TestContext, autosave = false) {
  const home = await mkdtemp(join(tmpdir(), 'wm-wechat-update-')); t.after(() => rm(home, { recursive: true, force: true }));
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close()); const context = await browser.newContext();
  const items = [0, 1].map(seq => ({ seq, title: '原始子项' + seq, content: '<p>原始正文' + seq + '</p>', author: '作者' + seq, digest: '手动摘要' + seq, cover: 'https://mmbiz.qpic.cn/' + seq + '.png', auto_gen_digest: 0, need_open_comment: 1 }));
  let saves = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/autosave') { const saved = JSON.parse(route.request().postData()!); items[saved.seq].content = saved.content; return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === '/save') { const saved = JSON.parse(route.request().postData()!); Object.assign(items[saved.seq], saved); saves++; return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<script>location.href="/cgi-bin/home?token=FIXTURE"</script>' });
    if (url.pathname === '/cgi-bin/home') return route.fulfill({ contentType: 'text/html', body: '<script>window.wx={data:{user_name:"stable-id",nick_name:"作者"}}</script>' });
    if (url.pathname !== '/cgi-bin/appmsg') return route.abort();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><textarea id="title" hidden>不能填写的旧标题</textarea><div id="js_title_main"><div class="ProseMirror" contenteditable="true"></div></div><input id="author"><textarea id="js_description"></textarea><div class="rich_media_content"><div class="ProseMirror" contenteditable="true"></div></div><div class="js_cover_preview_new">封面</div><div class="js_appmsg_item current">子项0</div><div class="js_appmsg_item">子项1</div><div id="js_submit"><button>保存为草稿</button></div><script>
    window.wx={cgiData:{app_id:'123456',idx:0,multi_appmsg_data:${JSON.stringify(items).replaceAll('<', '\\u003c')}}};const cgi=wx.cgiData; const title=document.querySelector('#js_title_main .ProseMirror'), body=document.querySelector('.rich_media_content .ProseMirror');
    function select(index){cgi.idx=index;const item=cgi.multi_appmsg_data[index];title.textContent=item.title;body.innerHTML=item.content;document.querySelector('#author').value=item.author;document.querySelector('#js_description').value=item.digest;document.querySelector('.js_cover_preview_new').style.backgroundImage='url('+item.cover+')';document.querySelectorAll('.js_appmsg_item').forEach((item,i)=>item.classList.toggle('current',i===index));}select(0);
    if(${autosave}) body.addEventListener('input',()=>fetch('/autosave',{method:'POST',body:JSON.stringify({seq:cgi.idx,content:body.innerHTML})}));
    document.querySelectorAll('.js_appmsg_item').forEach((item,i)=>item.onclick=()=>select(i));
    document.querySelector('#js_submit button').onclick=async()=>{await fetch('/save',{method:'POST',body:JSON.stringify({seq:cgi.idx,title:title.textContent,content:body.innerHTML,author:document.querySelector('#author').value,digest:document.querySelector('#js_description').value})});history.replaceState({},'',location.pathname+'?appmsgid=123456&token=FIXTURE');};
    </script>` });
  });
  const platform = createWechatPlatform({ withBrowser: async (_account, action) => { const page = await context.newPage(); try { return await action(context, page); } finally { await page.close(); } } });
  await new AccountRepository(home).login('wechat', 'main', async () => ({ id: 'stable-id', name: '作者' }));
  const service = new PublishingService(home, new PlatformRegistry([platform])); const file = join(home, 'article.md'); await writeFile(file, '# 新标题\n\n新正文内容，修改第二个子项。');
  return { home, service, file, items, saves: () => saves };
}

test('WeChat same-resource update edits the selected item while retaining its metadata and every other item', async t => {
  const { service, file, items, saves } = await wechatFixture(t); const untouched = structuredClone(items[0]);
  const base = (await service.invoke('wechat', 'main', 'resource.get', { resource: { kind: 'draft', id: '123456', selector: { item_index: '1' } } })).value;
  const result = await service.invoke('wechat', 'main', 'draft.update', { file, base });
  if (result.effect === 'remote-write') { assert.equal(result.value.targets[0].status, 'draft_saved', result.value.targets[0].message); assert.deepEqual(result.value.targets[0].remote, { kind: 'draft', id: '123456', selector: { item_index: '1' } }); }
  assert.equal(saves(), 1); assert.deepEqual(items[0], untouched); assert.equal(items[1].title, '新标题');
  assert.equal(items[1].author, '作者1'); assert.equal(items[1].digest, '手动摘要1'); assert.equal(items[1].cover, 'https://mmbiz.qpic.cn/1.png');
});

test('WeChat group version detects an external edit to another item and rejects ambiguous multi-item updates', async t => {
  const { service, file, items, saves } = await wechatFixture(t);
  const parent = (await service.invoke('wechat', 'main', 'resource.get', { resource: { kind: 'draft', id: '123456' } })).value;
  await assert.rejects(service.create('draft.update', { file, base: parent }, ['wechat']), /多篇|子项|selector/);
  const base = (await service.invoke('wechat', 'main', 'resource.get', { resource: { kind: 'draft', id: '123456', selector: { item_index: '1' } } })).value;
  items[0].title = '外部修改';
  const result = await service.invoke('wechat', 'main', 'draft.update', { file, base });
  if (result.effect === 'remote-write') { assert.equal(result.value.targets[0].requiredAction, 'review_remote_changes'); assert.equal(result.value.targets[0].failure?.code, 'CONFLICT'); }
  assert.equal(saves(), 0); assert.equal(items[1].title, '原始子项1');
});


test('a cache read failure inside a composing WeChat update stays unknown after autosave and cannot replay', async t => {
  const { home, service, file, items, saves } = await wechatFixture(t, true);
  const base = (await service.invoke('wechat', 'main', 'resource.get', { resource: { kind: 'draft', id: '123456', selector: { item_index: '1' } } })).value;
  await writeFile(join(home, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVJkAAAAASUVORK5CYII=', 'base64'));
  await writeFile(file, '# 新标题\n\n已经进入自动保存的正文。\n\n![图片](./image.png)');
  const artifact = await new ObjectStore(home).put(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVJkAAAAASUVORK5CYII=', 'base64'), 'image/png', '.png');
  const key = semanticDigest({ identity: await service.accounts.resolve('wechat'), artifact, purpose: 'article-image', protocol: 'wechat-mmbiz-v1' });
  await mkdir(join(home, 'cache', 'uploads'), { recursive: true });
  await writeFile(join(home, 'cache', 'uploads', key + '.json'), 'invalid JSON');
  const job = await service.create('draft.update', { file, base }, ['wechat']);
  const result = await service.run(job.id);
  assert.equal(result.targets[0].status, 'unknown'); assert.match(items[1].content, /已经进入自动保存/); assert.equal(saves(), 0);
  const after = items[1].content;
  assert.equal((await service.run(job.id)).targets[0].status, 'unknown');
  assert.equal(items[1].content, after); assert.equal(saves(), 0);
});
