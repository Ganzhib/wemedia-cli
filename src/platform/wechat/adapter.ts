import type { Artifact, ArtifactReader } from '../../core/content.js';
import { remoteReferenceSchema, operationResultSchema, resourceSnapshotSchema } from '../../core/types.js';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { errors, type BrowserContext, type Page } from 'playwright';
import { z } from 'zod';
import type { AccountProfile, OperationContext, OperationResult, RemoteReference } from '../../core/types.js';
import { definePlatform } from '../../core/platform.js';
import { readCapability, workflowCapability } from '../../core/capability.js';
import { stepHandler } from '../../core/workflow.js';
import { listInputSchema, resourceListSchema } from '../../core/schemas.js';
import { assetFrom, documentAssets, documentTitle, articleInputSchema, prepareArticle, preparedArticleSchema, type ArticleDocument } from '../../content/document.js';
import { omitRepeatedTitle } from '../../content/markdown.js';
import { withAccountBrowser, navigatePlatform, reloadPlatform } from '../../runtime/managed-browser.js';
import { resourceSnapshot, resourceBaseline, requireVersion } from '../../content/resources.js';
import { CliError } from '../../shared/errors.js';

const HOME = 'https://mp.weixin.qq.com/';
const EDITOR = '.rich_media_content .ProseMirror';
const TITLE = '#js_title_main .ProseMirror';
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
const preparedSchema = preparedArticleSchema.extend({ options: z.object({ author: z.string(), summary: z.string(), preserveAuthor: z.boolean(), preserveSummary: z.boolean() }) });
type WechatArticle = z.infer<typeof preparedSchema>;
interface WechatSession { profile: AccountProfile; browser: BrowserContext; page: Page }

export async function prepareWechat(document: ArticleDocument, options: z.infer<typeof wechatOptionsSchema>, existingCover?: string, requireCover = true): Promise<WechatArticle> {
  const title = documentTitle(document, options);
  if (Array.from(title).length > 64) throw new CliError('INPUT', '公众号标题最多 64 字，不会自动截断。');
  const assets = await documentAssets(document, options);
  if (assets.some(asset => !asset.artifact)) throw new CliError('INPUT', '公众号正文图片请先保存到本地，以便通过编辑器上传。');
  const coverSource = options.cover ?? assets[0]?.source;
  if (!coverSource && requireCover) throw new CliError('INPUT', '请提供公众号封面或至少一张正文图片。');
  const cover = coverSource ? await assetFrom(coverSource, document) : undefined;
  if (cover && !cover.artifact && coverSource !== existingCover) throw new CliError('INPUT', '新封面需要本地图片。');
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
    author: options.author ?? '', summary: options.summary ?? options.brief ?? '', preserveAuthor: false, preserveSummary: false,
  } };
}

async function newEditor(context: BrowserContext, home: Page): Promise<Page> {
  const [page] = await Promise.all([
    context.waitForEvent('page', { timeout: 30_000 }),
    home.locator('.new-creation__menu').getByText('文章', { exact: true }).click(),
  ]);
  await page.locator(TITLE).waitFor({ state: 'visible' });
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
  const html = dom.window.document.body.innerHTML; dom.window.close(); return { html, images };
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

function backgroundImageUrl(style: string): string | undefined { return style.match(/url\(["']?(.*?)["']?\)/)?.[1]; }
async function chooseCover(page: Page, source: string): Promise<string> {
  const emptyCover = page.locator('#js_cover_area .select-cover__btn').filter({ visible: true });
  if (await emptyCover.count()) await emptyCover.click();
  else {
    const primaryCover = page.locator('#js_cover_area .js_cover_preview_new');
    await primaryCover.hover(); await primaryCover.locator('.js_chooseCoverWrap').click();
  }
  await page.locator('#js_cover_area .js_selectCoverFromContent').filter({ visible: true }).first().click();
  const dialog = page.locator('.weui-desktop-dialog:visible');
  // The native picker renders candidates as CSS background spans, not img elements.
  const candidates = dialog.locator('.appmsg_content_img.cover').filter({ visible: true });
  await candidates.first().waitFor({ state: 'visible' });
  const backgrounds = await candidates.evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundImage));
  const index = backgrounds.findIndex(background => backgroundImageUrl(background)?.split('?')[0] === source.split('?')[0]);
  if (index < 0) throw new CliError('PROTOCOL', '封面选图窗口未包含刚上传的图片。');
  // The card's selection mask covers the thumbnail; click its owning card.
  await candidates.nth(index).locator('..').click();
  await dialog.getByRole('button', { name: '下一步', exact: true }).click();
  await page.locator('.weui-desktop-dialog:visible').getByRole('button', { name: /^(确认|确定)$/ }).click();
  const cover = page.locator('#js_cover_area .js_cover_preview_new:visible');
  await cover.waitFor({ state: 'visible' });
  const url = backgroundImageUrl(await cover.evaluate(element => getComputedStyle(element).backgroundImage));
  if (!url || !/^https?:\/\/mmbiz\./.test(url)) throw new CliError('UNKNOWN', '封面裁剪尚未返回平台图片地址。');
  return url;
}

export async function saveWechatDraft(page: Page): Promise<RemoteReference> {
  await page.locator('#js_submit button').click();
  await page.waitForFunction(() => {
    const id = new URL(location.href).searchParams.get('appmsgid');
    const button = document.querySelector<HTMLButtonElement>('#js_submit button');
    return !!id && !!button && !button.disabled && !document.querySelector('#js_submit')!.classList.contains('btn_loading');
  }, undefined, { timeout: 60_000 });
  const id = new URL(page.url()).searchParams.get('appmsgid')!;
  const index = await page.evaluate(() => (window as unknown as { wx: { cgiData: { idx: number } } }).wx.cgiData.idx);
  return { kind: 'draft', id, selector: { item_index: String(index) } };
}

type WechatComposition = Pick<OperationContext, 'artifacts' | 'uploads' | 'remember'>;
async function insertUploadedImage(page: Page, url: string) {
  await page.locator(EDITOR).evaluate((editor, url) => {
    (editor as HTMLElement).focus();
    const image = document.createElement('img'); image.src = url;
    document.execCommand('insertHTML', false, image.outerHTML);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, url);
}
async function reuseWechatImage(page: Page, artifact: Artifact, context: WechatComposition) {
  const url = await context.uploads.use(artifact, 'article-image', 'wechat-mmbiz-v1', z.string().url(), {
    upload: async () => {
      const url = await uploadIntoEditor(page, context.artifacts.path(artifact));
      return { value: url };
    },
    revalidate: async url => {
      const response = await page.context().request.get(url);
      const status = response.status(); const contentType = response.headers()['content-type']; await response.dispose();
      if (status === 404 || status === 410) return undefined;
      if (status !== 200 || !contentType?.startsWith('image/')) throw new CliError('NETWORK', '公众号素材地址未确认有效，不重复上传。');
      await insertUploadedImage(page, url); return { value: url };
    },
  });
  await context.remember({ kind: 'image', id: url, url, selector: { digest: artifact.digest } }, 'asset'); return url;
}
export async function composeWechatDraft(browser: BrowserContext, home: Page, article: WechatArticle, context: WechatComposition): Promise<RemoteReference> {
  return fillWechatEditor(await newEditor(browser, home), article, context);
}

async function fillWechatEditor(page: Page, article: WechatArticle, context: WechatComposition, resource?: WechatResource): Promise<RemoteReference> {
  const { artifacts } = context;
  await page.locator(TITLE).fill(article.title);
  if (!article.options.preserveAuthor) await page.locator('#author').fill(article.options.author);
  const prepared = placeholderHtml(article, artifacts);
  await insertWechatHtml(page, prepared.html);
  const uploaded = new Map<string, string>();
  for (const image of prepared.images) {
    await selectMarker(page, image.marker);
    const existing = uploaded.get(image.path);
    if (existing) {
      await insertUploadedImage(page, existing);
    } else {
      const asset = article.assets.find(asset => asset.artifact && artifacts.path(asset.artifact) === image.path)!;
      uploaded.set(image.path, await reuseWechatImage(page, asset.artifact!, context));
    }
  }
  let expectedCover = article.cover?.artifact ? undefined : article.cover?.source;
  if (article.cover?.artifact) {
    let cover = uploaded.get(artifacts.path(article.cover.artifact));
    let extraCover = false;
    if (!cover) {
      await page.locator(EDITOR).press('ControlOrMeta+End');
      cover = await reuseWechatImage(page, article.cover.artifact, context);
      extraCover = true;
    }
    expectedCover = await chooseCover(page, cover);
    await context.remember({ kind: 'cover', id: expectedCover, url: expectedCover, selector: { digest: article.cover.artifact.digest } }, 'asset');
    if (extraCover) {
      // The separate cover is only an upload source; do not add it to the author's body.
      await page.locator(EDITOR).evaluate((editor, url) => {
        for (const image of editor.querySelectorAll<HTMLImageElement>('img')) if (image.src === url) image.remove();
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }, cover);
    }
  }
  if (!article.options.preserveSummary) await page.locator('#js_description').fill(article.options.summary);
  if ((await page.locator(TITLE).innerText()).trim() !== article.title) throw new CliError('PROTOCOL', '正文处理改变了标题，停止保存。');
  const returned = await saveWechatDraft(page);
  if (resource && returned.id !== resource.id) throw new CliError('UNKNOWN', '保存返回了其他草稿 ID，停止后续操作。');
  const saved = resource ? { ...returned, selector: resource.selector } : returned;
  await context.remember(saved);
  await reloadPlatform(page);
  if (resource) await selectWechatItem(page, resource);
  await verifyWechatDraft(page, article, expectedCover);
  return saved;
}

async function verifyWechatDraft(page: Page, article: WechatArticle, expectedCover?: string): Promise<void> {
  const expected = new JSDOM(article.body);
  const normalize = (text: string) => text.normalize('NFC').replace(/\s+/g, '');
  const expectedText = normalize(expected.window.document.body.textContent!);
  const actualText = normalize(await page.locator(EDITOR).textContent() ?? '');
  const images = await page.locator(EDITOR + ' img:not(.ProseMirror-separator)').count();
  const expectedImages = expected.window.document.querySelectorAll('img').length;
  expected.window.close();
  const authorMatches = article.options.preserveAuthor || await page.locator('#author').inputValue() === article.options.author;
  const summaryMatches = article.options.preserveSummary || await page.locator('#js_description').inputValue() === article.options.summary;
  let coverMatches = true;
  if (expectedCover) {
    const cover = page.locator('.js_cover_preview_new:visible').first();
    coverMatches = await cover.count() > 0;
    if (coverMatches) {
      const background = await cover.evaluate(element => getComputedStyle(element).backgroundImage);
      const actualCover = backgroundImageUrl(background);
      coverMatches = actualCover?.split('?')[0] === expectedCover.split('?')[0];
    }
  }
  if ((await page.locator(TITLE).innerText()).trim() !== article.title || actualText !== expectedText || images !== expectedImages || !authorMatches || !summaryMatches || !coverMatches) {
    throw new CliError('UNKNOWN', '公众号草稿回读的标题、正文、图片或元数据与计划不符，请核对现有草稿，勿重复创建。', { checks: { title: (await page.locator(TITLE).innerText()).trim() === article.title, body: actualText === expectedText, images: images === expectedImages, author: authorMatches, summary: summaryMatches, cover: coverMatches } });
  }
}

function recoveredCover(article: WechatArticle, references: RemoteReference[]): string | undefined {
  if (!article.cover?.artifact) return article.cover?.source;
  const cover = references.find(reference => reference.kind === 'cover' && reference.selector?.digest === article.cover!.artifact!.digest);
  if (!cover?.url) throw new CliError('UNKNOWN', '缺少本次封面上传的回执，无法确认完整草稿。');
  return cover.url;
}

function editorUrl(home: Page, id: string): string {
  const url = new URL('/cgi-bin/appmsg', HOME);
  url.search = new URLSearchParams({ t: 'media/appmsg_edit', action: 'edit', type: '10', appmsgid: id, token: new URL(home.url()).searchParams.get('token')!, lang: 'zh_CN' }).toString();
  return url.href;
}

export async function publishWechatDraft(page: Page, draft: RemoteReference, timeoutMs = 180_000): Promise<OperationResult> {
  await navigatePlatform(page, editorUrl(page, draft.id!));
  await page.getByRole('button', { name: '发表', exact: true }).or(page.getByRole('link', { name: '发表', exact: true })).filter({ visible: true }).first().click();
  const confirmation = page.locator('.weui-desktop-dialog:visible');
  await confirmation.getByRole('button', { name: /^(发表|继续发表)$/ }).click();
  const verification = page.getByText(/请.*扫码|管理员.*验证/).first();
  if (await verification.isVisible()) process.stderr.write('微信要求管理员扫码确认此次发表，请在打开的窗口验证；完成后会自动继续。\n');
  try {
    await page.getByText('发表成功', { exact: true }).first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    if (await verification.isVisible()) throw new CliError('VERIFICATION', '微信发表仍需管理员扫码，任务已保留。', { verification: { kind: 'administrator_scan', strategy: 'inspect', resource: draft } });
    throw new CliError('UNKNOWN', '微信发表结果未确认，请查询任务和平台文章，勿重复提交。');
  }
  const links = page.locator('a[href^="https://mp.weixin.qq.com/s"]');
  const url = await links.count() ? await links.first().getAttribute('href') : null;
  return { status: 'published', remote: { kind: 'article', id: draft.id, ...(url ? { url } : {}) } };
}

const wechatResourceSchema = remoteReferenceSchema.extend({ kind: z.literal('draft'), selector: z.object({ item_index: z.string().regex(/^\d+$/) }).strict().optional() });
const wechatItemSchema = z.object({ seq: z.number(), title: z.string(), content: z.string(), author: z.string(), digest: z.string(), cover: z.string() }).catchall(z.json());
const wechatDataSchema = z.object({ items: z.array(wechatItemSchema).min(1) });
const wechatSnapshotSchema = resourceSnapshotSchema.extend({ resource: wechatResourceSchema, data: wechatDataSchema });
const wechatBaselineSchema = wechatSnapshotSchema.omit({ observedAt: true });
const updatePreparedSchema = preparedSchema.extend({ base: wechatBaselineSchema });
type WechatResource = z.infer<typeof wechatResourceSchema>;
interface WechatEditorData { app_id: string; multi_appmsg_data: z.infer<typeof wechatItemSchema>[] }
async function editorData(page: Page) {
  return page.evaluate(() => {
    const source = (window as unknown as { wx: { cgiData: WechatEditorData } }).wx.cgiData;
    return { id: String(source.app_id), items: source.multi_appmsg_data };
  });
}
async function selectWechatItem(page: Page, resource: WechatResource) {
  const data = await editorData(page);
  if (data.id !== resource.id) throw new CliError('PROTOCOL', '编辑器没有打开指定草稿。');
  const index = resource.selector ? data.items.findIndex(item => String(item.seq) === resource.selector!.item_index) : 0;
  if (index < 0) throw new CliError('INPUT', '草稿中不存在指定子项。');
  if (data.items.length > 1 && resource.selector) {
    await page.locator('.js_appmsg_item').nth(index).click();
    await page.waitForFunction(selected => document.querySelectorAll('.js_appmsg_item')[selected].classList.contains('current'), index);
  }
  return { ...data, index };
}
async function readWechatSnapshot(session: WechatSession, resource: WechatResource) {
  await navigatePlatform(session.page, editorUrl(session.page, resource.id));
  await session.page.locator(TITLE).waitFor({ state: 'visible' });
  const data = await selectWechatItem(session.page, resource);
  const reference: WechatResource = { ...resource, ...(data.items.length === 1 ? { selector: { item_index: String(data.items[0].seq) } } : {}) };
  return resourceSnapshot(reference, 'draft', { items: data.items });
}
function selectedWechatItem(base: z.infer<typeof wechatBaselineSchema>) {
  if (!base.resource.selector && base.data.items.length > 1) throw new CliError('INPUT', '多篇图文需要选择明确的 item_index，不能默认覆盖第一篇。');
  const selected = base.resource.selector ? base.data.items.find(item => String(item.seq) === base.resource.selector!.item_index) : base.data.items[0];
  if (!selected) throw new CliError('INPUT', '基准快照不含指定子项。');
  return selected;
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
  const handlers = {
      'draft.create': handler({ version: '1', effect: 'remote-write', input: preparedSchema, dependencies: z.strictObject({}), output: remoteReferenceSchema,
        execute: (context, article) => composeWechatDraft(context.session.browser, context.session.page, article, context),
        recover: async (context, article, _dependencies, saved) => {
          const remote = saved.references.find(reference => reference.kind === 'draft');
          if (!remote) return { verdict: 'indeterminate' as const, evidence: { source: 'draft', message: '缺少保存返回的草稿 ID，不重新创建。' } };
          await navigatePlatform(context.session.page, editorUrl(context.session.page, remote.id));
          await verifyWechatDraft(context.session.page, article, recoveredCover(article, saved.references));
          return { verdict: 'effect_confirmed' as const, value: remote, evidence: { source: 'draft.readback', message: '原草稿的标题、正文和图片已回读核对。', reference: remote } };
        },
      }),
      'article.publish': handler({ version: '1', effect: 'remote-write', input: z.strictObject({}), dependencies: z.object({ 'draft.create': remoteReferenceSchema }), output: operationResultSchema,
        execute: async (context, _input, dependencies) => {
          const result = await publishWechatDraft(context.session.page, dependencies['draft.create']);
          if (result.remote) await context.remember(result.remote);
          return result;
        },
        recover: async (context, _input, dependencies, saved) => {
          const confirmed = saved.references.find(reference => reference.kind === 'article');
          if (confirmed) return { verdict: 'effect_confirmed' as const, value: { status: 'published' as const, remote: confirmed }, evidence: { source: 'publication_receipt', message: '该步骤已记录发表成功页面返回的引用。', reference: confirmed } };
          const draft = dependencies['draft.create'];
          const articles = await listWechat(context.session.page, 'article', 100);
          const article = articles.find(article => article.id === draft.id);
          if (article) {
            const remote = { kind: 'article', id: article.id, ...(article.url ? { url: article.url } : {}) };
            return { verdict: 'effect_confirmed' as const, value: { status: 'published' as const, remote }, evidence: { source: 'publication.list', message: '发表记录包含原草稿对应的稳定 ID。', reference: remote } };
          }
          if (saved.verification) {
            await navigatePlatform(context.session.page, editorUrl(context.session.page, draft.id));
            if (await context.session.page.getByText(/请.*扫码|管理员.*验证/).first().isVisible()) {
              process.stderr.write('已恢复原发表验证页面，请完成管理员扫码。\n');
              try {
                await context.session.page.getByText('发表成功', { exact: true }).first().waitFor({ state: 'visible', timeout: 180_000 });
                const remote = { kind: 'article', id: draft.id };
                return { verdict: 'effect_confirmed' as const, value: { status: 'published' as const, remote }, evidence: { source: 'verification_success', message: '原验证流程显示发表成功。', reference: remote } };
              } catch (error) { if (!(error instanceof errors.TimeoutError)) throw error; }
            }
          }
          return { verdict: 'indeterminate' as const, evidence: { source: 'publication', message: '发表记录未确认此 ID，不能仅凭草稿存在再次发表。', reference: draft } };
        } }),
      'draft.existing': handler({ version: '1', effect: 'read', input: wechatBaselineSchema, dependencies: z.strictObject({}), output: remoteReferenceSchema,
        execute: async (context, base) => {
          requireVersion(base, await readWechatSnapshot(context.session, base.resource));
          if (base.data.items.length !== 1) throw new CliError('INPUT', '普通发表作用于整组图文；当前此能力只接受单篇草稿。');
          await context.remember(base.resource); return base.resource;
        } }),
      'draft.update': handler({ version: '1', effect: 'remote-write', input: updatePreparedSchema, dependencies: z.strictObject({}), output: remoteReferenceSchema,
        execute: async (context, article) => {
          requireVersion(article.base, await readWechatSnapshot(context.session, article.base.resource));
          await context.remember(article.base.resource);
          const remote = await fillWechatEditor(context.session.page, article, context, article.base.resource);
          return remote;
        },
        recover: async (context, article, _dependencies, saved) => {
          const current = await readWechatSnapshot(context.session, article.base.resource);
          try {
            await verifyWechatDraft(context.session.page, article, recoveredCover(article, saved.references));
            return { verdict: 'effect_confirmed' as const, value: article.base.resource, evidence: { source: 'draft.readback', message: '原草稿子项回读匹配本次更新。', reference: article.base.resource } };
          } catch (error) {
            if (!(error instanceof CliError) || error.code !== 'UNKNOWN') throw error;
            if (current.version === article.base.version) return { verdict: 'not_applied' as const, evidence: { source: 'draft.version', message: '原草稿整组仍是更新前版本，本次内容没有保存。', reference: article.base.resource } };
            return { verdict: 'indeterminate' as const, evidence: { source: 'draft.version', message: '草稿已变化但不匹配本次更新，不能覆盖或重复保存。', reference: article.base.resource } };
          }
        } }),
      'draft.updated-result': handler({ version: '1', effect: 'read', input: updatePreparedSchema, dependencies: z.object({ 'draft.update': remoteReferenceSchema }), output: operationResultSchema,
        execute: async (context, article, dependencies) => {
          const current = await readWechatSnapshot(context.session, article.base.resource);
          const selected = selectedWechatItem(article.base);
          const unchanged = article.base.data.items.filter(item => item.seq !== selected.seq);
          if (JSON.stringify(current.data.items.filter(item => item.seq !== selected.seq)) !== JSON.stringify(unchanged)) throw new CliError('UNKNOWN', '其他图文子项发生变化，已保留原草稿 ID。');
          return { status: 'draft_saved' as const, remote: dependencies['draft.update'], observation: { state: 'draft', remote: dependencies['draft.update'], snapshot: current } };
        } }),
      'draft.result': handler({ version: '1', effect: 'read', input: z.strictObject({}), dependencies: z.object({ 'draft.create': remoteReferenceSchema }), output: operationResultSchema,
        execute: async (_context, _input, dependencies) => ({ status: 'draft_saved' as const, remote: dependencies['draft.create'] }) }),
    };
  const writing = (id: string, description: string, publish: boolean) => workflowCapability<WechatSession>()({
    id, description, acceptance: publish ? acceptance : { ...acceptance, liveRead: true, liveWrite: true }, successStates: publish ? ['submitted', 'published'] : ['draft_saved'], input: articleInputSchema(wechatOptionsSchema), prepared: preparedSchema, output: operationResultSchema,
    prepare: (raw, context) => prepareArticle(raw, context, 'wechat', wechatOptionsSchema, (document, options) => prepareWechat(document, options, undefined, publish)), preflight: async () => undefined,
    compile: article => ({ id, version: '1', resultStep: publish ? 'article.publish' : 'draft.result', steps: [
      { id: 'draft.create', handler: 'draft.create', version: '1', needs: [], input: JSON.parse(JSON.stringify(article)) },
      { id: publish ? 'article.publish' : 'draft.result', handler: publish ? 'article.publish' : 'draft.result', version: '1', needs: ['draft.create'], input: {} },
    ] }),
    handlers,

    inspect: async ({ session }, remote, expected) => {
      if (remote.kind === 'draft') {
        await navigatePlatform(session.page, editorUrl(session.page, remote.id));
        await verifyWechatDraft(session.page, expected);
        return { state: 'draft_saved', remote };
      }
      const articles = await listWechat(session.page, 'article', 100);
      const article = articles.find(article => article.id === remote.id);
      if (!article) return { state: 'unknown', remote, message: '当前列表未返回此 ID，不能推断发布或删除成功。' };
      return { state: 'published', remote: { ...remote, ...(article.url ? { url: article.url } : {}) } };
    },
  });
  return definePlatform<WechatSession>({
    id: 'wechat', name: '微信公众号', driver: { id: 'wechat.browser', version: '5' },
    login: directory => browser({ directory }, (_context, page) => wechatProfile(page, true)),
    withSession: (account, action) => browser(account, async (context, page) => action({ profile: await wechatProfile(page), browser: context, page })),
    capabilities: [
      readCapability<WechatSession>()({ id: 'resource.get', description: '读取草稿整组版本，或按稳定 ID 回查发表记录', acceptance: { ...acceptance, liveRead: true },
        input: z.strictObject({ resource: remoteReferenceSchema.extend({ kind: z.enum(['draft', 'article']), selector: z.object({ item_index: z.string().regex(/^\d+$/) }).strict().optional() }) }), output: resourceSnapshotSchema,
        execute: async ({ session }, input) => {
          if (input.resource.kind === 'draft') return readWechatSnapshot(session, { ...input.resource, kind: 'draft' });
          const items = (await listWechat(session.page, 'article', 100)).filter(article => article.id === input.resource.id && (!input.resource.selector || String(article.item_index) === input.resource.selector.item_index));
          return resourceSnapshot(input.resource, items.length ? 'published' : 'unknown', { items });
        } }),
      workflowCapability<WechatSession>()({ id: 'draft.update', description: '核对整组版本后更新指定草稿子项并回读，不新建草稿', acceptance: { ...acceptance, liveRead: true, liveWrite: true }, successStates: ['draft_saved'],
        input: articleInputSchema(wechatOptionsSchema).extend({ base: wechatSnapshotSchema }), prepared: updatePreparedSchema, output: operationResultSchema, handlers,
        prepare: async (raw, context) => {
          const base = resourceBaseline(raw.base); const existing = selectedWechatItem(base);
          const article = await prepareArticle(raw, context, 'wechat', wechatOptionsSchema, async (document, options) => {
            const article = await prepareWechat(document, options, existing.cover, false);
            const supplied = { ...document.metadata, ...document.platforms.wechat, ...raw.options };
            article.options.preserveAuthor = !Object.hasOwn(supplied, 'author');
            article.options.preserveSummary = !Object.hasOwn(supplied, 'summary') && !Object.hasOwn(supplied, 'brief');
            return article;
          }, { author: existing.author, summary: existing.digest, cover: existing.cover });
          return { ...article, base };
        },
        preflight: async () => undefined,
        compile: article => ({ id: 'draft.update', version: '1', resultStep: 'draft.updated-result', steps: [
          { id: 'draft.update', handler: 'draft.update', version: '1', needs: [], input: JSON.parse(JSON.stringify(article)) },
          { id: 'draft.updated-result', handler: 'draft.updated-result', version: '1', needs: ['draft.update'], input: JSON.parse(JSON.stringify(article)) },
        ] }),
      }),
      workflowCapability<WechatSession>()({ id: 'draft.publish', description: '核对版本后发表同一单篇草稿，不创建副本、不群发', acceptance, successStates: ['published'],
        input: z.strictObject({ base: wechatSnapshotSchema }), prepared: z.object({ base: wechatBaselineSchema }), output: operationResultSchema, handlers,
        prepare: async input => ({ base: resourceBaseline(input.base) }), preflight: async () => undefined,
        compile: input => ({ id: 'draft.publish', version: '1', resultStep: 'article.publish', steps: [
          { id: 'draft.create', handler: 'draft.existing', version: '1', needs: [], input: input.base },
          { id: 'article.publish', handler: 'article.publish', version: '1', needs: ['draft.create'], input: {} },
        ] }),
      }),
      writing('draft.create', '排版、上传正文图片、设置封面、保存并回读草稿', false),
      writing('content.publish', '正式发表；平台要求时等待管理员扫码，不包含群发', true),
      ...(['draft', 'article'] as const).map(kind => readCapability<WechatSession>()({
        id: kind + '.list', description: kind === 'draft' ? '查询公众号草稿箱' : '查询公众号发表记录', acceptance: { ...acceptance, liveRead: true },
        input: listInputSchema, output: resourceListSchema,
        execute: async ({ session }, input) => ({ items: (await listWechat(session.page, kind, input.limit)).map(article => ({
          resource: { kind, id: article.id, ...(article.url ? { url: article.url } : {}), ...(article.item_index !== undefined ? { selector: { item_index: String(article.item_index) } } : {}) }, title: article.title,
        })) }),
      })),
    ],
  });
}
