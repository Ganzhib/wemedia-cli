import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type BrowserContext } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeWechatDraft, insertWechatHtml, publishWechatDraft, readWechatList } from '../../src/platform/wechat/adapter.js';
import { submitXhs, xhsProfile } from '../../src/platform/xiaohongshu/adapter.js';
import { ensureBrowser } from '../../src/runtime/managed-browser.js';
import { CliError } from '../../src/shared/errors.js';

async function browser(t: TestContext): Promise<BrowserContext> {
  await ensureBrowser();
  const instance = await chromium.launch({ headless: true });
  t.after(() => instance.close());
  return instance.newContext();
}

test('body insertion cannot overwrite a focused title and triggers editor input', async t => {
  const context = await browser(t);
  const page = await context.newPage();
  await page.setContent('<input id="title" value="Original title"><div class="rich_media_content"><div class="ProseMirror" contenteditable="true"></div></div><script>window.inputCount=0;document.querySelector(".ProseMirror").addEventListener("input",()=>window.inputCount++)</script>');
  await page.locator('#title').focus();
  await insertWechatHtml(page, '<p style="color: red">正文 <strong>内容</strong></p>');
  assert.equal(await page.locator('#title').inputValue(), 'Original title');
  assert.equal(await page.locator('.ProseMirror').innerText(), '正文 内容');
  assert.ok(await page.evaluate('window.inputCount > 0'));
});

const editorFixture = `<!doctype html><meta charset="utf-8">
<input id="title"><input id="author"><textarea id="js_description"></textarea>
<div class="rich_media_content"><div class="ProseMirror" contenteditable="true"></div></div>
<input type="file" accept="image/*"><a id="cover">从正文选择</a><div id="coverPreview"></div>
<div id="dialogs"></div><div id="js_submit"><button>保存为草稿</button></div><button id="publish">发表</button>
<script>
const editor=document.querySelector('.ProseMirror');
const stored=localStorage.getItem('draft');
if(stored){const saved=JSON.parse(stored);document.querySelector('#title').value=saved.title;editor.innerHTML=saved.body;}
document.querySelector('input[type=file]').onchange=()=>{
 const image=document.createElement('img');image.src='https://mmbiz.qpic.cn/uploaded.png';
 const selection=window.getSelection();if(selection.rangeCount&&editor.contains(selection.anchorNode)){selection.getRangeAt(0).insertNode(image);}else editor.append(image);
};
document.querySelector('#cover').onclick=()=>{
 document.querySelector('#dialogs').innerHTML='<div class="weui-desktop-dialog"><img width="128" height="128" src="https://mmbiz.qpic.cn/uploaded.png"><button id="next">下一步</button></div>';
 document.querySelector('#next').onclick=()=>{
  document.querySelector('#dialogs').innerHTML='<div class="weui-desktop-dialog"><button id="confirm">确认</button></div>';
  document.querySelector('#confirm').onclick=()=>{document.querySelector('#dialogs').innerHTML='';document.querySelector('#coverPreview').className='js_cover_preview_new';document.querySelector('#coverPreview').textContent='已设置封面';};
 };
};
document.querySelector('#js_submit button').onclick=()=>{
 localStorage.setItem('draft',JSON.stringify({title:document.querySelector('#title').value,body:editor.innerHTML}));
 history.replaceState({},'',location.pathname+'?token=PRIVATE_FIXTURE_TOKEN&appmsgid=123456');
};
document.querySelector('#publish').onclick=()=>{
 document.querySelector('#dialogs').innerHTML='<div class="weui-desktop-dialog"><button id="final">继续发表</button></div>';
 document.querySelector('#final').onclick=()=>{document.querySelector('#dialogs').innerHTML='<div>发表成功</div><a href="https://mp.weixin.qq.com/s/fixture-public">查看文章</a>';};
};
</script>`;

test('WeChat compose uploads at the body marker, sets cover, saves and reads back a credential-free draft reference', async t => {
  const context = await browser(t);
  // Every request is intercepted. This fixture cannot write to any real platform.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'mmbiz.qpic.cn') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVJkAAAAASUVORK5CYII=', 'base64') });
    if (url.hostname !== 'mp.weixin.qq.com') return route.abort();
    if (url.pathname === '/cgi-bin/home') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div class="new-creation__menu"><a target="_blank" href="/cgi-bin/appmsg?token=PRIVATE_FIXTURE_TOKEN">文章</a></div>' });
    return route.fulfill({ contentType: 'text/html', body: editorFixture });
  });
  const directory = await mkdtemp(join(tmpdir(), 'wm-browser-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = join(directory, 'cover.png');
  await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVJkAAAAASUVORK5CYII=', 'base64'));
  const page = await context.newPage();
  await page.goto('https://mp.weixin.qq.com/cgi-bin/home?token=PRIVATE_FIXTURE_TOKEN');
  const draft = await composeWechatDraft(context, page, {
    title: '完整发布流程', body: '<p>图片之前</p><p><img src="./cover.png"></p><p>图片之后</p>', format: 'html',
    assets: [{ source: './cover.png', path: image, digest: '1234567890abcdef' }],
    cover: { source: './cover.png', path: image }, options: { author: '作者', summary: '摘要' },
  });
  assert.deepEqual(draft, { kind: 'draft', id: '123456' });
  assert.ok(!JSON.stringify(draft).includes('PRIVATE_FIXTURE_TOKEN'));
  const editor = context.pages().find(candidate => candidate !== page)!;
  assert.match(await editor.locator('.ProseMirror').innerText(), /图片之前[\s\S]*图片之后/);
  assert.equal(await editor.locator('.ProseMirror img').count(), 1);
  const published = await publishWechatDraft(page, draft);
  assert.equal(published.status, 'published');
  assert.equal(published.remote?.url, 'https://mp.weixin.qq.com/s/fixture-public');
});

test('Xiaohongshu captures note ID and treats explicit business rejection separately from transport uncertainty', async t => {
  for (const response of [{ code: 0, data: { note_id: '0123456789abcdef01234567' } }, { code: -9136, msg: '需要验证' }]) {
    const context = await browser(t);
    await context.route('**/*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(response), headers: { 'Access-Control-Allow-Origin': '*' } }));
    const page = await context.newPage();
    await page.setContent('<xhs-publish-btn is-publish="true"></xhs-publish-btn><script>document.querySelector("xhs-publish-btn").addEventListener("publish",()=>fetch("https://edith.xiaohongshu.com/web_api/sns/v2/note",{method:"POST"}))</script>');
    if (response.code === 0) {
      const result = await submitXhs(page, 3000);
      assert.equal(result.remote?.id, '0123456789abcdef01234567');
      assert.equal(result.status, 'submitted');
    } else await assert.rejects(submitXhs(page, 3000), (error: CliError) => error.code === 'API' && error.details?.outcome === 'rejected');
  }
});

test('an absent publish response is a timeout, never a fabricated success', async t => {
  const context = await browser(t);
  const page = await context.newPage();
  await page.setContent('<xhs-publish-btn is-publish="true"></xhs-publish-btn>');
  await assert.rejects(submitXhs(page, 200), /Timeout/);
});

test('account discovery ignores hidden responsive navigation clones', async t => {
  const context = await browser(t);
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    '<div class="main-container"><div class="user"><div class="link-wrapper"><a class="link-wrapper" style="display:none" href="/user/profile/badbad">我</a><a class="link-wrapper" href="/user/profile/abcdef012345">我</a></div></div></div><div class="user-name">登录账号</div>',
  }));
  const profile = await xhsProfile(await context.newPage());
  assert.deepEqual(profile, { id: 'abcdef012345', name: '登录账号' });
});

test('WeChat list reads stable IDs from current page data and distinguishes empty from unrecognized pages', async t => {
  const page = await (await browser(t)).newPage();
  await page.setContent('<div class="weui-desktop-publish" data-appid="42">草稿</div><script>window.wx={cgiData:{item:[{app_id:42,title:"草稿"}]}}</script>');
  assert.deepEqual(await readWechatList(page, 'draft', 10), [{ id: '42', title: '草稿' }]);
  await page.evaluate(() => { (window as any).wx.cgiData = { publish_list: [] }; });
  assert.deepEqual(await readWechatList(page, 'article', 10), []);
  await page.evaluate(() => { (window as any).wx.cgiData = { publish_list: [{ publish_info: JSON.stringify({ appmsgex: [{ appmsgid: 43, itemidx: 1, title: '文章', link: 'https://mp.weixin.qq.com/s/example' }] }) }] }; });
  assert.deepEqual(await readWechatList(page, 'article', 10), [{ id: '43', item_index: 1, title: '文章', url: 'https://mp.weixin.qq.com/s/example' }]);
  await assert.rejects(readWechatList(page, 'draft', 10), (error: CliError) => error.code === 'PROTOCOL');
});
