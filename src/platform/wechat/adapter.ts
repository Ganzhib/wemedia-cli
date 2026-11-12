import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { errors, type BrowserContext, type Page } from 'playwright';
import type { AccountProfile, ArticleDocument, OperationContext, OperationResult, PlatformAdapter, PreparedArticle, RemoteReference } from '../../core/types.js';
import { assetFrom, documentAssets, documentTitle, textOption } from '../../content/document.js';
import { omitRepeatedTitle } from '../../content/markdown.js';
import { withAccountBrowser, navigatePlatform, reloadPlatform } from '../../runtime/managed-browser.js';
import type { AccountStore } from '../../runtime/accounts.js';
import { CliError } from '../../shared/errors.js';

const HOME = 'https://mp.weixin.qq.com/';
const EDITOR = '.rich_media_content .ProseMirror';
interface WechatPageData { user_name?: string; nick_name?: string; fakeid?: string; nickname?: string }
type WechatWindow = Window & { wx?: { data?: WechatPageData; cgiData?: WechatPageData } };

export async function wechatProfile(page: Page, login = false): Promise<AccountProfile> {
  await navigatePlatform(page, HOME);
  if (login) process.stderr.write('请在打开的微信公众平台页面扫码登录。\n');
  try { await page.waitForURL(url => url.pathname.includes('/cgi-bin/') && url.searchParams.has('token'), { timeout: login ? 300_000 : 20_000 }); }
  catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
    throw new CliError('AUTH', '公众号尚未登录或会话失效，请运行 wm auth login wechat。');
  }
  const profile = await page.evaluate(() => {
    const wx = (window as WechatWindow).wx;
    const data = { ...wx?.cgiData, ...wx?.data };
    const id = data.user_name ?? data.fakeid;
    const name = data.nick_name ?? data.nickname ?? document.querySelector('.weui-desktop-account__nickname')?.textContent?.trim();
    return { id, name };
  });
  if (!profile.id || !profile.name) throw new CliError('PROTOCOL', '登录页面未返回公众号的稳定 ID 和名称，不能确认目标账号。');
  return { id: String(profile.id), name: profile.name };
}

export async function prepareWechat(document: ArticleDocument, options: Record<string, unknown>): Promise<PreparedArticle> {
  const title = documentTitle(document, options);
  if (Array.from(title).length > 64) throw new CliError('INPUT', '公众号标题最多 64 字，不会自动截断。');
  const assets = await documentAssets(document, options);
  if (assets.some(asset => !asset.path)) throw new CliError('INPUT', '公众号正文图片请先保存到本地，以便通过编辑器上传。');
  const coverSource = textOption(options, 'cover', assets[0]?.source ?? '');
  if (!coverSource) throw new CliError('INPUT', '请提供公众号封面或至少一张正文图片。');
  const cover = await assetFrom(coverSource, document);
  if (!cover.path) throw new CliError('INPUT', '公众号封面需要本地图片。');
  const { renderStyledContent } = await import('@wenyan-md/core/wrapper');
  const rendered = await renderStyledContent(omitRepeatedTitle(document.markdown, title), {
    themeId: textOption(options, 'theme', 'default'), hlThemeId: 'github', isMacStyle: false, isAddFootnote: true,
  });
  // Source HTML enters an authenticated editor. Strip active content before preview or insertion.
  const window = new JSDOM('').window;
  const body = createDOMPurify(window).sanitize(rendered, { FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form'] });
  window.close();
  return { title, body, format: 'html', assets, cover, options: {
    author: textOption(options, 'author'), summary: textOption(options, 'summary', textOption(options, 'brief')),
  } };
}

async function newEditor(context: BrowserContext, home: Page): Promise<Page> {
  const [page] = await Promise.all([
    context.waitForEvent('page', { timeout: 30_000 }),
    home.locator('.new-creation__menu').getByText('文章', { exact: true }).click(),
  ]);
  await page.locator('#title').waitFor({ state: 'visible' });
  await page.locator(EDITOR).waitFor({ state: 'visible' });
  return page;
}

// Ported from JimLiu/baoyu-skills wechat-article.ts (MIT). Using the editor's input
// lifecycle avoids clipboard permissions and prevents HTML from entering the title field.
export async function insertWechatHtml(page: Page, html: string): Promise<void> {
  const inserted = await page.locator(EDITOR).evaluate((element, body) => {
    const editor = element as HTMLElement;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const accepted = document.execCommand('insertHTML', false, body);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertHTML' }));
    return accepted && editor.textContent!.trim().length > 0;
  }, html);
  if (!inserted) throw new CliError('PROTOCOL', '公众号正文未进入编辑器，停止保存。');
}

function placeholderHtml(article: PreparedArticle): { html: string; images: { marker: string; path: string }[] } {
  const dom = new JSDOM(article.body);
  const images: { marker: string; path: string }[] = [];
  for (const image of dom.window.document.querySelectorAll('img')) {
    const source = decodeURI(image.getAttribute('src') ?? '');
    const asset = article.assets.find(asset => asset.source === source || asset.path === source);
    if (!asset?.path) throw new CliError('INPUT', '正文图片不在已校验的资产清单中：' + source);
    const marker = 'WM_IMAGE_' + images.length + '_' + asset.digest!.slice(0, 16);
    images.push({ marker, path: asset.path });
    image.replaceWith(dom.window.document.createTextNode(marker));
  }
  return { html: dom.window.document.body.innerHTML, images };
}

async function selectMarker(page: Page, marker: string): Promise<void> {
  const found = await page.locator(EDITOR).evaluate((editor, value) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = node.textContent!.indexOf(value);
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + value.length);
      (editor as HTMLElement).focus();
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    return false;
  }, marker);
  if (!found) throw new CliError('PROTOCOL', '图片占位符未出现在公众号正文中，停止上传。');
  await page.keyboard.press('Backspace');
}

async function uploadIntoEditor(page: Page, path: string): Promise<string> {
  const before = await page.locator(EDITOR + ' img').evaluateAll(images => images.map(image => image.getAttribute('src')));
  await page.locator('input[type="file"][accept*="image"]').first().setInputFiles(path);
  await page.waitForFunction(({ selector, previous }) => Array.from(document.querySelectorAll<HTMLImageElement>(selector)).some(image =>
    /^https?:\/\/mmbiz\./.test(image.src) && !previous.includes(image.getAttribute('src'))), { selector: EDITOR + ' img', previous: before }, { timeout: 90_000 });
  return page.locator(EDITOR + ' img').evaluateAll((images, previous) => {
    const added = images.find(image => !previous.includes(image.getAttribute('src')) && /^https?:\/\/mmbiz\./.test((image as HTMLImageElement).src));
    return (added as HTMLImageElement).src;
  }, before);
}

async function chooseCover(page: Page, source: string): Promise<void> {
  await page.getByText('从正文选择', { exact: true }).click();
  const dialog = page.locator('.weui-desktop-dialog:visible');
  const image = dialog.locator('img').filter({ visible: true });
  const matches = await image.evaluateAll((images, url) => images.findIndex(image => (image as HTMLImageElement).src.split('?')[0] === url.split('?')[0]), source);
  if (matches < 0) throw new CliError('PROTOCOL', '封面选图窗口未包含刚上传的图片。');
  await image.nth(matches).click();
  await dialog.getByRole('button', { name: '下一步', exact: true }).click();
  await page.locator('.weui-desktop-dialog:visible').getByRole('button', { name: /^(确认|确定)$/ }).click();
  await page.locator('.js_cover_preview_new:visible, .js_cover_preview_square:visible').first().waitFor({ state: 'visible' });
}

export async function saveWechatDraft(page: Page): Promise<RemoteReference> {
  await page.locator('#js_submit button').click();
  await page.waitForFunction(() => {
    const id = new URL(location.href).searchParams.get('appmsgid');
    const button = document.querySelector<HTMLButtonElement>('#js_submit button');
    return !!id && !!button && !button.disabled && !document.querySelector('#js_submit')!.classList.contains('btn_loading');
  }, undefined, { timeout: 60_000 });
  const id = new URL(page.url()).searchParams.get('appmsgid')!;
  return { kind: 'draft', id };
}

export async function composeWechatDraft(context: BrowserContext, home: Page, article: PreparedArticle, onSaved?: (remote: RemoteReference) => Promise<void>): Promise<RemoteReference> {
  const page = await newEditor(context, home);
  await page.locator('#title').fill(article.title);
  if (article.options.author) await page.locator('#author').fill(article.options.author as string);
  const prepared = placeholderHtml(article);
  await insertWechatHtml(page, prepared.html);
  const uploaded = new Map<string, string>();
  for (const image of prepared.images) {
    await selectMarker(page, image.marker);
    const existing = uploaded.get(image.path);
    if (existing) {
      await page.locator(EDITOR).evaluate((editor, url) => {
        (editor as HTMLElement).focus();
        const image = document.createElement('img');
        image.src = url;
        document.execCommand('insertHTML', false, image.outerHTML);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }, existing);
    } else uploaded.set(image.path, await uploadIntoEditor(page, image.path));
  }
  let cover = uploaded.get(article.cover!.path!);
  let extraCover = false;
  if (!cover) {
    await page.locator(EDITOR).press('ControlOrMeta+End');
    cover = await uploadIntoEditor(page, article.cover!.path!);
    extraCover = true;
  }
  await chooseCover(page, cover);
  if (extraCover) {
    // The separate cover is only an upload source; do not add it to the author's body.
    await page.locator(EDITOR).evaluate((editor, url) => {
      for (const image of editor.querySelectorAll<HTMLImageElement>('img')) if (image.src === url) image.remove();
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }, cover);
  }
  if (article.options.summary) await page.locator('#js_description').fill(article.options.summary as string);
  if (await page.locator('#title').inputValue() !== article.title) throw new CliError('PROTOCOL', '正文处理改变了标题，停止保存。');
  const saved = await saveWechatDraft(page);
  await onSaved?.(saved);
  await reloadPlatform(page);
  await verifyWechatDraft(page, article);
  return saved;
}

async function verifyWechatDraft(page: Page, article: PreparedArticle): Promise<void> {
  const expected = new JSDOM(article.body);
  const normalize = (text: string) => text.normalize('NFC').replace(/\s+/g, '');
  const expectedText = normalize(expected.window.document.body.textContent!);
  const actualText = normalize(await page.locator(EDITOR).textContent() ?? '');
  const images = await page.locator(EDITOR + ' img:not(.ProseMirror-separator)').count();
  const expectedImages = expected.window.document.querySelectorAll('img').length;
  expected.window.close();
  if (await page.locator('#title').inputValue() !== article.title || actualText !== expectedText || images !== expectedImages) {
    throw new CliError('UNKNOWN', '公众号草稿回读的标题、正文或图片与计划不符，请核对现有草稿，勿重复创建。');
  }
}

function editorUrl(home: Page, id: string): string {
  const url = new URL('/cgi-bin/appmsg', HOME);
  url.search = new URLSearchParams({ t: 'media/appmsg_edit', action: 'edit', type: '10', appmsgid: id, token: new URL(home.url()).searchParams.get('token')!, lang: 'zh_CN' }).toString();
  return url.href;
}

export async function publishWechatDraft(page: Page, draft: RemoteReference): Promise<OperationResult> {
  await navigatePlatform(page, editorUrl(page, draft.id!));
  await page.getByRole('button', { name: '发表', exact: true }).or(page.getByRole('link', { name: '发表', exact: true })).filter({ visible: true }).first().click();
  const confirmation = page.locator('.weui-desktop-dialog:visible');
  await confirmation.getByRole('button', { name: /^(发表|继续发表)$/ }).click();
  const verification = page.getByText(/请.*扫码|管理员.*验证/).first();
  if (await verification.isVisible()) process.stderr.write('微信要求管理员扫码确认此次发表，请在打开的窗口验证；完成后会自动继续。\n');
  try {
    await page.getByText('发表成功', { exact: true }).first().waitFor({ state: 'visible', timeout: 180_000 });
  } catch {
    if (await verification.isVisible()) throw new CliError('VERIFICATION', '微信发表仍需管理员扫码，任务已保留。');
    throw new CliError('UNKNOWN', '微信发表结果未确认，请查询任务和平台文章，勿重复提交。');
  }
  const links = page.locator('a[href^="https://mp.weixin.qq.com/s"]');
  const url = await links.count() ? await links.first().getAttribute('href') : null;
  return { status: 'published', remote: { kind: 'article', id: draft.id, ...(url ? { url } : {}) } };
}

async function writeWechat(context: OperationContext, article: PreparedArticle, publish: boolean): Promise<OperationResult> {
  return withAccountBrowser(context.account, async (browser, page) => {
    await context.account.verify(await wechatProfile(page));
    const draft = await context.step('draft.create', () => composeWechatDraft(browser, page, article, remote => context.remember(remote)));
    await context.remember(draft);
    if (!publish) return { status: 'draft_saved', remote: draft };
    return context.step('article.publish', () => publishWechatDraft(page, draft));
  });
}

interface WechatDraftItem { app_id: number; title: string }
interface WechatPublishedInfo { appmsgex: { appmsgid: number; itemidx: number; title: string; link: string }[] }
interface WechatListData {
  item?: WechatDraftItem[];
  publish_list?: { publish_info: string }[];
}

export async function readWechatList(page: Page, kind: 'draft' | 'article', limit: number): Promise<{ id: string; title: string; url?: string; item_index?: number }[]> {
  // The current masonry cards use data-appid, not the old data-appmsgid selector.
  // Read the same page bootstrap payload used by that UI, retaining stable IDs even for empty lists.
  const data = await page.evaluate(() => (window as unknown as { wx: { cgiData: WechatListData } }).wx.cgiData);
  if (kind === 'draft') {
    if (!Array.isArray(data.item)) throw new CliError('PROTOCOL', '公众号草稿列表结构已改变，未将未知页面当作空列表。');
    return data.item.slice(0, limit).map(item => ({ id: String(item.app_id), title: item.title }));
  }
  if (!Array.isArray(data.publish_list)) throw new CliError('PROTOCOL', '公众号发表记录结构已改变，未将未知页面当作空列表。');
  return data.publish_list.flatMap(record => {
    const info = JSON.parse(record.publish_info) as WechatPublishedInfo;
    return info.appmsgex.map(article => ({ id: String(article.appmsgid), item_index: article.itemidx, title: article.title, url: article.link }));
  }).slice(0, limit);
}

async function listWechat(page: Page, account: AccountStore, kind: 'draft' | 'article', limit: number) {
  await account.verify(await wechatProfile(page));
  const name = kind === 'draft' ? '草稿箱' : '发表记录';
  const href = await page.getByRole('link', { name, exact: true }).getAttribute('href');
  if (!href) throw new CliError('PROTOCOL', '公众号未提供列表导航入口。');
  const url = new URL(href, HOME);
  url.searchParams.set('count', String(limit));
  await navigatePlatform(page, url.href);
  await page.getByRole('heading', { name, exact: true }).waitFor();
  return readWechatList(page, kind, limit);
}

export function createWechatAdapter(): PlatformAdapter {
  return {
    id: 'wechat', name: '微信公众号', driver: 'wechat.browser', version: '1',
    operations: {
      draft: { description: '排版、上传图片、设置封面并保存公众号草稿，随后回读', run: (context, article) => writeWechat(context, article, false) },
      publish: { description: '创建草稿并正式发表；平台要求扫码时等待管理员验证，不包含群发', run: (context, article) => writeWechat(context, article, true) },
    },
    lists: {
      draft: { description: '查询公众号草稿箱', run: (account, limit) => withAccountBrowser(account, (_browser, page) => listWechat(page, account, 'draft', limit)) },
      article: { description: '查询公众号发表记录', run: (account, limit) => withAccountBrowser(account, (_browser, page) => listWechat(page, account, 'article', limit)) },
    },
    prepare: prepareWechat,
    login: account => withAccountBrowser(account, (_browser, page) => wechatProfile(page, true)),
    status: account => withAccountBrowser(account, async (_browser, page) => account.verify(await wechatProfile(page))),
    inspect: (account, remote, expected) => withAccountBrowser(account, async (_browser, page) => {
      if (remote.kind === 'draft' && expected) {
        await account.verify(await wechatProfile(page));
        await navigatePlatform(page, editorUrl(page, remote.id!));
        await verifyWechatDraft(page, expected);
        return { status: 'draft_saved', remote };
      }
      const articles = await listWechat(page, account, remote.kind === 'draft' ? 'draft' : 'article', 100);
      const article = articles.find(article => article.id === remote.id);
      if (!article) return { status: 'unknown', remote, message: '当前列表未返回此 ID，不能推断发布或删除成功。' };
      return { status: remote.kind === 'draft' ? 'draft_saved' : 'published', remote: { ...remote, ...(article.url ? { url: article.url } : {}) } };
    }),
  };
}
