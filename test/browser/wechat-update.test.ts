import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createWechatPlatform } from '../../src/platform/wechat/adapter.js';
import { AccountRepository } from '../../src/runtime/accounts.js';
import { PlatformRegistry } from '../../src/core/registry.js';
import { PublishingService } from '../../src/services/publishing.js';

async function wechatFixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'wm-wechat-update-')); t.after(() => rm(home, { recursive: true, force: true }));
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close()); const context = await browser.newContext();
  const items = [0, 1].map(seq => ({ seq, title: '原始子项' + seq, content: '<p>原始正文' + seq + '</p>', author: '作者' + seq, digest: '手动摘要' + seq, cover: 'https://mmbiz.qpic.cn/' + seq + '.png', auto_gen_digest: 0, need_open_comment: 1 }));
  let saves = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/save') { const saved = JSON.parse(route.request().postData()!); Object.assign(items[saved.seq], saved); saves++; return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<script>location.href="/cgi-bin/home?token=FIXTURE"</script>' });
    if (url.pathname === '/cgi-bin/home') return route.fulfill({ contentType: 'text/html', body: '<script>window.wx={data:{user_name:"stable-id",nick_name:"作者"}}</script>' });
    if (url.pathname !== '/cgi-bin/appmsg') return route.abort();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><textarea id="title" hidden>不能填写的旧标题</textarea><div id="js_title_main"><div class="ProseMirror" contenteditable="true"></div></div><input id="author"><textarea id="js_description"></textarea><div class="rich_media_content"><div class="ProseMirror" contenteditable="true"></div></div><div class="js_cover_preview_new">封面</div><div class="js_appmsg_item current">子项0</div><div class="js_appmsg_item">子项1</div><div id="js_submit"><button>保存为草稿</button></div><script>
    window.wx={cgiData:{app_id:'123456',idx:0,multi_appmsg_data:${JSON.stringify(items).replaceAll('<', '\\u003c')}}};const cgi=wx.cgiData; const title=document.querySelector('#js_title_main .ProseMirror'), body=document.querySelector('.rich_media_content .ProseMirror');
    function select(index){cgi.idx=index;const item=cgi.multi_appmsg_data[index];title.textContent=item.title;body.innerHTML=item.content;document.querySelector('#author').value=item.author;document.querySelector('#js_description').value=item.digest;document.querySelector('.js_cover_preview_new').style.backgroundImage='url('+item.cover+')';document.querySelectorAll('.js_appmsg_item').forEach((item,i)=>item.classList.toggle('current',i===index));}select(0);
    document.querySelectorAll('.js_appmsg_item').forEach((item,i)=>item.onclick=()=>select(i));
    document.querySelector('#js_submit button').onclick=async()=>{await fetch('/save',{method:'POST',body:JSON.stringify({seq:cgi.idx,title:title.textContent,content:body.innerHTML,author:document.querySelector('#author').value,digest:document.querySelector('#js_description').value})});history.replaceState({},'',location.pathname+'?appmsgid=123456&token=FIXTURE');};
    </script>` });
  });
  const platform = createWechatPlatform({ withBrowser: async (_account, action) => { const page = await context.newPage(); try { return await action(context, page); } finally { await page.close(); } } });
  await new AccountRepository(home).login('wechat', 'main', async () => ({ id: 'stable-id', name: '作者' }));
  const service = new PublishingService(home, new PlatformRegistry([platform])); const file = join(home, 'article.md'); await writeFile(file, '# 新标题\n\n新正文内容，修改第二个子项。');
  return { service, file, items, saves: () => saves };
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
