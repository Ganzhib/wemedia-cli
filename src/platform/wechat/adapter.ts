import type { ArtifactReader } from '../../core/content.js';
import { remoteReferenceSchema, operationResultSchema } from '../../core/types.js';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { errors, type BrowserContext, type Page } from 'playwright';
import { z } from 'zod';
import type { AccountProfile, OperationResult, RemoteReference } from '../../core/types.js';
import { definePlatform } from '../../core/platform.js';
import { readCapability, workflowCapability } from '../../core/capability.js';
import { stepHandler } from '../../core/workflow.js';
import { listInputSchema, resourceListSchema } from '../../core/schemas.js';
import { assetFrom, documentAssets, documentTitle, articleInputSchema, prepareArticle, preparedArticleSchema, type ArticleDocument } from '../../content/document.js';
import { omitRepeatedTitle } from '../../content/markdown.js';
import { withAccountBrowser, navigatePlatform, reloadPlatform } from '../../runtime/managed-browser.js';
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

export const wechatOptionsSchema = z.object({
  title: z.string().meta({ maxCodePoints: 64 }).optional(), author: z.string().optional(), summary: z.string().optional(), brief: z.string().optional(),
  cover: z.string().optional(), images: z.array(z.string()).optional(), theme: z.string().optional(),
});
const preparedSchema = preparedArticleSchema.extend({ options: z.object({ author: z.string(), summary: z.string() }) });
type WechatArticle = z.infer<typeof preparedSchema>;
interface WechatSession { profile: AccountProfile; browser: BrowserContext; page: Page }

export async function prepareWechat(document: ArticleDocument, options: z.infer<typeof wechatOptionsSchema>): Promise<WechatArticle> {
  const title = documentTitle(document, options);
  if (Array.from(title).length > 64) throw new CliError('INPUT', '公众号标题最多 64 字，不会自动截断。');
  const assets = await documentAssets(document, options);
  if (assets.some(asset => !asset.artifact)) throw new CliError('INPUT', '公众号正文图片请先保存到本地，以便通过编辑器上传。');
  const coverSource = options.cover ?? assets[0]?.source;
  if (!coverSource) throw new CliError('INPUT', '请提供公众号封面或至少一张正文图片。');
  const cover = await assetFrom(coverSource, document);
  if (!cover.artifact) throw new CliError('INPUT', '公众号封面需要本地图片。');
  const { renderStyledContent } = await import('@wenyan-md/core/wrapper');
  const rendered = await renderStyledContent(omitRepeatedTitle(document.markdown, title), {
    themeId: options.theme ?? 'default', hlThemeId: 'github', isMacStyle: false, isAddFootnote: true,
  });
  // Source HTML enters an authenticated editor. Strip active content before preview or insertion.
  const window = new JSDOM('').window;
  const body = createDOMPurify(window).sanitize(rendered, { FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form'] });
  const normalized = new JSDOM(body);
  for (const image of normalized.window.document.querySelectorAll('img')) image.setAttribute('src', (await assetFrom(decodeURI(image.getAttribute('src') ?? ''), document)).source);
  const html = normalized.window.document.body.innerHTML;
  normalized.window.close();
  window.close();
  return { title, body: html, format: 'text/html', assets, cover, options: {
    author: options.author ?? '', summary: options.summary ?? options.brief ?? '',
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

function placeholderHtml(article: WechatArticle, artifacts: ArtifactReader): { html: string; images: { marker: string; path: string }[] } {
  const dom = new JSDOM(article.body);
  const images: { marker: string; path: string }[] = [];
  for (const image of dom.window.document.querySelectorAll('img')) {
    const source = decodeURI(image.getAttribute('src') ?? '');
    const asset = article.assets.find(asset => asset.source === source);
    if (!asset?.artifact) throw new CliError('INPUT', '正文图片不在已校验的资产清单中：' + source);
    const marker = 'WM_IMAGE_' + images.length + '_' + asset.artifact.digest.slice(0, 16);
    images.push({ marker, path: artifacts.path(asset.artifact) });
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

export async function composeWechatDraft(context: BrowserContext, home: Page, article: WechatArticle, artifacts: ArtifactReader, onSaved?: (remote: RemoteReference) => Promise<void>): Promise<RemoteReference> {
  const page = await newEditor(context, home);
  await page.locator('#title').fill(article.title);
  if (article.options.author) await page.locator('#author').fill(article.options.author);
  const prepared = placeholderHtml(article, artifacts);
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
  let cover = uploaded.get(artifacts.path(article.cover!.artifact!));
  let extraCover = false;
  if (!cover) {
    await page.locator(EDITOR).press('ControlOrMeta+End');
    cover = await uploadIntoEditor(page, artifacts.path(article.cover!.artifact!));
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
  if (article.options.summary) await page.locator('#js_description').fill(article.options.summary);
  if (await page.locator('#title').inputValue() !== article.title) throw new CliError('PROTOCOL', '正文处理改变了标题，停止保存。');
  const saved = await saveWechatDraft(page);
  await onSaved?.(saved);
  await reloadPlatform(page);
  await verifyWechatDraft(page, article);
  return saved;
}

async function verifyWechatDraft(page: Page, article: WechatArticle): Promise<void> {
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

async function listWechat(page: Page, kind: 'draft' | 'article', limit: number) {
  const name = kind === 'draft' ? '草稿箱' : '发表记录';
  const href = await page.getByRole('link', { name, exact: true }).getAttribute('href');
  if (!href) throw new CliError('PROTOCOL', '公众号未提供列表导航入口。');
  const url = new URL(href, HOME);
  url.searchParams.set('count', String(limit));
  await navigatePlatform(page, url.href);
  await page.getByRole('heading', { name, exact: true }).waitFor();
  return readWechatList(page, kind, limit);
}

export function createWechatPlatform(dependencies: { withBrowser?: typeof withAccountBrowser } = {}) {
  const browser = dependencies.withBrowser ?? withAccountBrowser;
  const acceptance = { offline: true, liveRead: false, liveWrite: false };
  const handler = stepHandler<WechatSession>();
  const writing = (id: string, description: string, publish: boolean) => workflowCapability<WechatSession>()({
    id, description, acceptance, successStates: publish ? ['submitted', 'published'] : ['draft_saved'], input: articleInputSchema(wechatOptionsSchema), prepared: preparedSchema, output: operationResultSchema,
    prepare: (raw, context) => prepareArticle(raw, context, 'wechat', wechatOptionsSchema, prepareWechat), preflight: async () => undefined,
    compile: article => ({ id, version: '1', resultStep: publish ? 'article.publish' : 'draft.result', steps: [
      { id: 'draft.create', handler: 'draft.create', version: '1', needs: [], input: JSON.parse(JSON.stringify(article)) },
      { id: publish ? 'article.publish' : 'draft.result', handler: publish ? 'article.publish' : 'draft.result', version: '1', needs: ['draft.create'], input: {} },
    ] }),
    handlers: {
      'draft.create': handler({ version: '1', effect: 'remote-write', input: preparedSchema, dependencies: z.strictObject({}), output: remoteReferenceSchema,
        execute: (context, article) => composeWechatDraft(context.session.browser, context.session.page, article, context.artifacts, remote => context.remember(remote)),
      }),
      'article.publish': handler({ version: '1', effect: 'remote-write', input: z.strictObject({}), dependencies: z.object({ 'draft.create': remoteReferenceSchema }), output: operationResultSchema,
        execute: (context, _input, dependencies) => publishWechatDraft(context.session.page, dependencies['draft.create']) }),
      'draft.result': handler({ version: '1', effect: 'read', input: z.strictObject({}), dependencies: z.object({ 'draft.create': remoteReferenceSchema }), output: operationResultSchema,
        execute: async (_context, _input, dependencies) => ({ status: 'draft_saved' as const, remote: dependencies['draft.create'] }) }),
    },
    inspect: async ({ session }, remote, expected) => {
      if (remote.kind === 'draft') {
        await navigatePlatform(session.page, editorUrl(session.page, remote.id));
        await verifyWechatDraft(session.page, expected);
        return { status: 'draft_saved', remote };
      }
      const articles = await listWechat(session.page, 'article', 100);
      const article = articles.find(article => article.id === remote.id);
      if (!article) return { status: 'unknown', remote, message: '当前列表未返回此 ID，不能推断发布或删除成功。' };
      return { status: 'published', remote: { ...remote, ...(article.url ? { url: article.url } : {}) } };
    },
  });
  return definePlatform<WechatSession>({
    id: 'wechat', name: '微信公众号', driver: { id: 'wechat.browser', version: '4' },
    login: directory => browser({ directory }, (_context, page) => wechatProfile(page, true)),
    withSession: (account, action) => browser(account, async (context, page) => action({ profile: await wechatProfile(page), browser: context, page })),
    capabilities: [
      writing('draft.create', '排版、上传正文图片、设置封面、保存并回读草稿', false),
      writing('content.publish', '正式发表；平台要求时等待管理员扫码，不包含群发', true),
      ...(['draft', 'article'] as const).map(kind => readCapability<WechatSession>()({
        id: kind + '.list', description: kind === 'draft' ? '查询公众号草稿箱' : '查询公众号发表记录', acceptance,
        input: listInputSchema, output: resourceListSchema,
        execute: async ({ session }, input) => ({ items: (await listWechat(session.page, kind, input.limit)).map(article => ({
          resource: { kind, id: article.id, ...(article.url ? { url: article.url } : {}), ...(article.item_index !== undefined ? { selector: { item_index: String(article.item_index) } } : {}) }, title: article.title,
        })) }),
      })),
    ],
  });
}
