import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type BrowserContext } from 'playwright';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeWechatDraft, insertWechatHtml, publishWechatDraft, readWechatList, createWechatPlatform } from '../../src/platform/wechat/adapter.js';
import { submitXhs, xhsProfile, createXiaohongshuPlatform } from '../../src/platform/xiaohongshu/adapter.js';
import { ensureBrowser } from '../../src/runtime/managed-browser.js';
import { CliError } from '../../src/shared/errors.js';
import { AccountRepository } from '../../src/runtime/accounts.js';
import { PlatformRegistry } from '../../src/core/registry.js';
import { ObjectStore } from '../../src/runtime/objects.js';
import { PublishingService } from '../../src/services/publishing.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVJkAAAAASUVORK5CYII=', 'base64');
async function contentFixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'wm-adapter-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, 'article.md');
  await writeFile(join(home, 'cover.png'), png);
  await writeFile(file, '# 实际流程\n\n完整正文内容。\n\n![图片](./cover.png)');
  return { home, file };
}

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
document.querySelector('input[type=file]').onchange=async e=>{
 window.uploadedBytes=Array.from(new Uint8Array(await e.target.files[0].arrayBuffer()));localStorage.setItem('uploadedBytes',JSON.stringify(window.uploadedBytes));
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
  const objects = new ObjectStore(directory);
  const artifact = await objects.put(await readFile(image), 'image/png', '.png');
  const page = await context.newPage();
  await page.goto('https://mp.weixin.qq.com/cgi-bin/home?token=PRIVATE_FIXTURE_TOKEN');
  const draft = await composeWechatDraft(context, page, {
    title: '完整发布流程', body: '<p>图片之前</p><p><img src="./cover.png"></p><p>图片之后</p>', format: 'html',
    assets: [{ source: './cover.png', artifact }],
    cover: { source: './cover.png', artifact }, options: { author: '作者', summary: '摘要' },
  }, objects);
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

test('WeChat capability runs through account binding, one browser session, real composing and durable receipts', async t => {
  const { home, file } = await contentFixture(t);
  let opens = 0, closes = 0, profileLoads = 0;
  let uploadedBytes: number[] = [];
  const platform = createWechatPlatform({ withBrowser: async (_account, action) => {
    opens++;
    await writeFile(join(home, 'cover.png'), 'changed during login');
    const context = await browser(t);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'mmbiz.qpic.cn') return route.fulfill({ contentType: 'image/png', body: png });
      if (url.hostname !== 'mp.weixin.qq.com') return route.abort();
      if (url.pathname === '/') { profileLoads++; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<script>history.replaceState({},"","/cgi-bin/home?token=FIXTURE");window.wx={data:{user_name:"wechat-id",nick_name:"Creator"}}</script><div class="new-creation__menu"><a target="_blank" href="/cgi-bin/appmsg?token=FIXTURE">文章</a></div>' }); }
      if (url.pathname === '/cgi-bin/home') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<script>window.wx={data:{user_name:"wechat-id",nick_name:"Creator"}}</script><div class="new-creation__menu"><a target="_blank" href="/cgi-bin/appmsg?token=FIXTURE">文章</a></div>' });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: editorFixture });
    });
    try {
      const result = await action(context, await context.newPage());
      uploadedBytes = await context.pages().find(page => new URL(page.url()).pathname === '/cgi-bin/appmsg')!.evaluate('JSON.parse(localStorage.getItem("uploadedBytes"))');
      return result;
    }
    finally { await context.close(); closes++; }
  } });
  const accounts = new AccountRepository(home);
  await accounts.login('wechat', 'main', async () => ({ id: 'wechat-id', name: 'Creator' }));
  const service = new PublishingService(home, new PlatformRegistry([platform]));
  const job = await service.create('draft.create', { file }, ['wechat']);
  await rm(file);
  const result = await service.run(job.id);
  assert.equal(result.targets[0].status, 'draft_saved', result.targets[0].message);
  assert.equal(result.targets[0].remote?.id, '123456');
  assert.equal(result.targets[0].steps['draft.create'].phase, 'done');
  assert.deepEqual(uploadedBytes, [...png]);
  await service.run(job.id);
  assert.deepEqual({ opens, closes, profileLoads }, { opens: 1, closes: 1, profileLoads: 1 });
});

test('Xiaohongshu capability fills images and formal topics and captures the real submission response in one session', async t => {
  const { home, file } = await contentFixture(t);
  let opens = 0, closes = 0, submissions = 0;
  let uploadedNote: number[] = [];
  let submitted: { title: string; images: number; topics: number } | undefined;
  const profile = '<div class="main-container"><div class="user"><div class="link-wrapper"><a class="link-wrapper" href="/user/profile/abcdef012345">我</a></div></div></div><div class="user-name">Creator</div><div class="feeds-container"><div class="note-item"><a class="cover" href="/explore/0123456789abcdef01234567">封面</a><div class="title">实际流程</div></div></div>';
  const composer = `<!doctype html><meta charset="utf-8"><div class="creator-tab">上传图文</div><input type="file" multiple>
    <div class="img-preview-area"></div><div class="d-input"><input></div><div class="ql-editor" contenteditable="true"></div>
    <div id="creator-editor-topic-container"><button class="item">工程</button></div><xhs-publish-btn is-publish="true"></xhs-publish-btn>
    <script>
    let count=0;
    document.querySelector('input[type=file]').onchange=async e=>{window.uploadedBytes=Array.from(new Uint8Array(await e.target.files[0].arrayBuffer()));count=e.target.files.length;document.querySelector('.img-preview-area').innerHTML='<div class="pr"></div>'.repeat(count);};
    document.querySelector('.item').onclick=()=>{const topic=document.createElement('a');topic.dataset.topicId='topic-1';topic.textContent='#工程';document.querySelector('.ql-editor').append(topic);};
    document.querySelector('xhs-publish-btn').addEventListener('publish',()=>fetch('https://edith.xiaohongshu.com/web_api/sns/v2/note',{method:'POST',body:JSON.stringify({title:document.querySelector('.d-input input').value,images:count,topics:document.querySelectorAll('a[data-topic-id]').length})}));
    </script>`;
  const platform = createXiaohongshuPlatform({ withBrowser: async (_account, action) => {
    opens++;
    await writeFile(join(home, 'cover.png'), 'changed during login');
    const context = await browser(t);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'edith.xiaohongshu.com') {
        submissions++; submitted = route.request().postDataJSON();
        return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ code: 0, data: { note_id: '0123456789abcdef01234567' } }) });
      }
      if (url.hostname === 'creator.xiaohongshu.com') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: composer });
      if (url.hostname === 'www.xiaohongshu.com') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: profile });
      return route.abort();
    });
    try {
      const page = await context.newPage(); const result = await action(context, page);
      if (new URL(page.url()).hostname === 'creator.xiaohongshu.com') uploadedNote = await page.evaluate('window.uploadedBytes');
      return result;
    }
    finally { await context.close(); closes++; }
  } });
  await new AccountRepository(home).login('xiaohongshu', 'main', async () => ({ id: 'abcdef012345', name: 'Creator' }));
  const service = new PublishingService(home, new PlatformRegistry([platform]));
  const job = await service.create('content.publish', { file, options: { content: '针对图文平台准备的正文。', tags: ['工程'] } }, ['xiaohongshu']);
  await rm(file);
  const result = await service.run(job.id);
  assert.equal(result.targets[0].status, 'submitted', result.targets[0].message);
  assert.equal(result.targets[0].remote?.kind, 'note');
  assert.equal(result.targets[0].remote?.id, '0123456789abcdef01234567');
  assert.deepEqual(uploadedNote, [...png]);
  assert.deepEqual(submitted, { title: '实际流程', images: 1, topics: 1 });
  await service.run(job.id);
  assert.deepEqual({ opens, closes, submissions }, { opens: 1, closes: 1, submissions: 1 });
  const list = await service.invoke('xiaohongshu', 'main', 'article.list', { limit: 2 });
  assert.deepEqual(list.value, { items: [{ resource: { kind: 'note', id: '0123456789abcdef01234567', url: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567' }, title: '实际流程' }] });
  assert.deepEqual({ opens, closes, submissions }, { opens: 2, closes: 2, submissions: 1 });
});

test('WeChat list capabilities use the shared identity session and retain multi-item resource selectors', async t => {
  const { home } = await contentFixture(t);
  let opens = 0, closes = 0;
  const platform = createWechatPlatform({ withBrowser: async (_account, action) => {
    opens++;
    const context = await browser(t);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mp.weixin.qq.com') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<script>history.replaceState({},"","/cgi-bin/home?token=FIXTURE");window.wx={data:{user_name:"wechat-id",nick_name:"Creator"}}</script><a href="/cgi-bin/appmsg">草稿箱</a><a href="/cgi-bin/appmsgpublish">发表记录</a>' });
      assert.equal(url.searchParams.get('count'), '3');
      const draft = url.pathname === '/cgi-bin/appmsg';
      const data = draft ? { item: [{ app_id: 42, title: '草稿' }] } : { publish_list: [{ publish_info: JSON.stringify({ appmsgex: [{ appmsgid: 43, itemidx: 1, title: '文章', link: 'https://mp.weixin.qq.com/s/example' }] }) }] };
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h3>' + (draft ? '草稿箱' : '发表记录') + '</h3><script>window.wx={cgiData:' + JSON.stringify(data) + '}</script>' });
    });
    try { return await action(context, await context.newPage()); }
    finally { await context.close(); closes++; }
  } });
  await new AccountRepository(home).login('wechat', 'main', async () => ({ id: 'wechat-id', name: 'Creator' }));
  const service = new PublishingService(home, new PlatformRegistry([platform]));
  assert.deepEqual((await service.invoke('wechat', 'main', 'draft.list', { limit: 3 })).value, { items: [{ resource: { kind: 'draft', id: '42' }, title: '草稿' }] });
  assert.deepEqual((await service.invoke('wechat', 'main', 'article.list', { limit: 3 })).value, { items: [{ resource: { kind: 'article', id: '43', url: 'https://mp.weixin.qq.com/s/example', selector: { item_index: '1' } }, title: '文章' }] });
  assert.deepEqual({ opens, closes }, { opens: 2, closes: 2 });
});
