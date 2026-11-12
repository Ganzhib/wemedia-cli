import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { errors, type Page, type Response as BrowserResponse } from 'playwright';
import { z } from 'zod';
import { definePlatform } from '../../core/platform.js';
import { readCapability, workflowCapability } from '../../core/capability.js';
import { stepHandler } from '../../core/workflow.js';
import type { ContentPreparation } from '../../core/content.js';
import { artifactSchema } from '../../core/content.js';
import { operationResultSchema, remoteReferenceSchema, resourceSnapshotSchema, type AccountProfile, type CapabilityContext } from '../../core/types.js';
import { listInputSchema, resourceListSchema } from '../../core/schemas.js';
import { articleInputSchema, assetFrom, documentAssets, documentTitle, prepareArticle, preparedArticleSchema } from '../../content/document.js';
import { omitRepeatedTitle } from '../../content/markdown.js';
import { requireVersion, resourceBaseline, resourceSnapshot } from '../../content/resources.js';
import { navigatePlatform, withAccountBrowser } from '../../runtime/managed-browser.js';
import { CliError } from '../../shared/errors.js';

const ORIGIN = 'https://zhuanlan.zhihu.com';
const TITLE = '请输入标题（最多 100 个字）';
const BODY = '[contenteditable="true"][role="textbox"]';
interface ZhihuSession { profile: AccountProfile; urlToken: string; page: Page }
interface Me { id: string; name: string; url_token: string }
interface ArticleData { id: string; title: string; content: string; state: string; image_url?: string; topics?: z.infer<ReturnType<typeof z.json>>[]; column?: z.infer<ReturnType<typeof z.json>>; creationStatement?: z.infer<ReturnType<typeof z.json>>; author: { id: string } }
async function browserJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.evaluate(async path => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    return { status: response.status, payload: response.ok ? await response.json() : null };
  }, path);
  if (response.status === 401) throw new CliError('AUTH', '知乎会话已失效，请重新登录。');
  if (response.status !== 200) throw new CliError('API', '知乎只读请求未成功。', { status: response.status });
  return response.payload as T;
}
export async function zhihuProfile(page: Page, login = false) {
  await navigatePlatform(page, 'https://www.zhihu.com/' + (login ? 'signin' : ''));
  let me: Me;
  if (login) {
    process.stderr.write('请在打开的知乎浏览器中扫码登录；需要安全验证时在页面完成。\n');
    try {
      // This Playwright runtime treats a returned Promise as truthy in waitForFunction.
      // Wait on the real login navigation, then verify the account with a single read.
      await page.waitForURL(url => url.hostname === 'www.zhihu.com' && !url.pathname.startsWith('/signin'), { timeout: 300_000 });
      me = await browserJson<Me>(page, '/api/v4/me');
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      throw new CliError('AUTH', '知乎登录尚未完成，请重新运行 wm auth login zhihu。');
    }
  } else me = await browserJson<Me>(page, '/api/v4/me');
  if (!me.id || !me.name || !me.url_token) throw new CliError('PROTOCOL', '知乎未返回稳定账号 ID、名称和个人主页标识。');
  // url_token is only a navigation handle. Account binding always uses the immutable me.id.
  return { profile: { id: me.id, name: me.name }, urlToken: me.url_token, page };
}

export const zhihuOptionsSchema = z.object({ title: z.string().optional(), images: z.array(z.string()).optional(), cover: z.string().optional(), declaration: z.enum(['none', 'ai_assisted']).optional() });
const preparedSchema = preparedArticleSchema.extend({ options: z.object({ declaration: z.enum(['none', 'ai_assisted']) }) });
type ZhihuArticle = z.infer<typeof preparedSchema>;
const resourceSchema = remoteReferenceSchema.extend({ kind: z.enum(['draft', 'article']), id: z.string().regex(/^\d+$/) });
const savedDataSchema = z.object({ title: z.string(), body: z.string(), cover: z.string(), topics: z.array(z.json()), column: z.json(), declaration: z.json() });
const snapshotSchema = resourceSnapshotSchema.extend({ resource: resourceSchema, data: savedDataSchema });
const baselineSchema = snapshotSchema.omit({ observedAt: true });
async function openEditor(session: ZhihuSession, id: string) {
  await navigatePlatform(session.page, `${ORIGIN}/p/${id}/edit`);
  await session.page.getByPlaceholder(TITLE).waitFor({ state: 'visible' });
  await session.page.locator(BODY).waitFor({ state: 'visible' });
}
async function readResource(session: ZhihuSession, resource: z.infer<typeof resourceSchema>) {
  await openEditor(session, resource.id);
  const article = await browserJson<ArticleData>(session.page, `/api/articles/${resource.id}${resource.kind === 'draft' ? '/draft' : ''}`);
  if (article.author.id !== session.profile.id) throw new CliError('INPUT', '此资源不属于当前知乎账号。');
  return resourceSnapshot(resource, article.state, { title: article.title, body: article.content, cover: article.image_url ?? '', topics: article.topics ?? [], column: article.column ?? null, declaration: article.creationStatement ?? null });
}
function normalizeHtml(html: string) {
  const dom = new JSDOM(html); const body = dom.window.document.body;
  const text = body.textContent!.normalize('NFC').replace(/[\s\u200B-\u200D\uFEFF]/gu, '');
  const images = Array.from(body.querySelectorAll('img'), image => image.src);
  dom.window.close(); return { text, images };
}
function expectedBody(article: ZhihuArticle, uploads: Record<string, string>) {
  const dom = new JSDOM(article.body);
  for (const image of dom.window.document.querySelectorAll('img')) {
    const source = decodeURI(image.getAttribute('src')!); const asset = article.assets.find(asset => asset.source === source)!;
    image.src = asset.artifact ? uploads[uploadStep(asset.artifact)] : asset.source;
  }
  const body = dom.window.document.body.innerHTML; dom.window.close(); return body;
}
function uploadStep(artifact: z.infer<typeof artifactSchema>) { return 'asset.' + artifact.digest; }
function sameBody(expected: string, actual: string) { return JSON.stringify(normalizeHtml(expected)) === JSON.stringify(normalizeHtml(actual)); }
async function responseDuring(page: Page, predicate: (response: BrowserResponse) => boolean, action: () => Promise<unknown>, timeout = 60_000) {
  const response = page.waitForResponse(predicate, { timeout });
  try { await action(); } catch (error) { void response.catch(() => undefined); throw error; }
  return response;
}
// Native allocation, paste, image and cover controls are adapted from the pinned MIT projects
// in THIRD_PARTY_NOTICES. No request signing or exported browser credentials are used.
async function allocate(context: CapabilityContext<ZhihuSession>, article: ZhihuArticle) {
  const page = context.session.page; await navigatePlatform(page, ORIGIN + '/write');
  const response = await responseDuring(page, response => new URL(response.url()).pathname === '/api/articles/drafts' && response.request().method() === 'POST', () => page.getByPlaceholder(TITLE).fill(article.title));
  if (!response.ok()) throw new CliError('UNKNOWN', '知乎草稿分配结果未确认，不会再次创建。');
  const draft = await response.json() as { id?: string };
  if (!draft.id) throw new CliError('UNKNOWN', '知乎草稿未返回 ID，不会按标题推测。');
  const remote = { kind: 'draft', id: String(draft.id) }; await context.remember(remote); return remote;
}
async function pasteHtml(page: Page, html: string) {
  const editor = page.locator(BODY);
  await editor.click(); await editor.press('ControlOrMeta+End'); await editor.press('Enter');
  await editor.press('ControlOrMeta+A'); await editor.press('Backspace'); await editor.click();
  await editor.evaluate((element, html) => {
    const clipboard = new DataTransfer(); clipboard.setData('text/html', html);
    clipboard.setData('text/plain', new DOMParser().parseFromString(html, 'text/html').body.textContent!);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, html);
}
const imageReceiptSchema = z.object({ id: z.string(), url: z.string().url() });
async function nativeUpload(context: CapabilityContext<ZhihuSession>, artifact: z.infer<typeof artifactSchema>) {
  const page = context.session.page; const input = page.locator('input[type="file"][accept="image/*"]');
  if (!await input.count()) await page.getByRole('button', { name: '图片', exact: true }).click();
  const response = await responseDuring(page, response => new URL(response.url()).hostname === 'api.zhihu.com' && /^\/images\/\d+$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET' && response.ok(), () => input.setInputFiles(context.artifacts.path(artifact)), 90_000);
  const image = await response.json() as { original_src?: string; src: string };
  const url = image.original_src ?? image.src;
  if (!/^https:\/\/[^/]+\.zhimg\.com\//.test(url)) throw new CliError('UNKNOWN', '知乎图片未返回已完成的 CDN 地址。');
  const receipt = { id: new URL(response.url()).pathname.split('/').at(-1)!, url };
  await context.remember({ kind: 'image', id: receipt.id, url }, 'asset'); return receipt;
}
async function cachedUpload(context: CapabilityContext<ZhihuSession>, artifact: z.infer<typeof artifactSchema>, upload = () => nativeUpload(context, artifact)) {
  return context.uploads.use(artifact, 'article-image', 'zhihu-image-v1', imageReceiptSchema, {
    upload: async () => ({ value: await upload() }),
    revalidate: async receipt => {
      const response = await context.session.page.context().request.get('https://api.zhihu.com/images/' + receipt.id);
      if (response.status() === 404) return undefined;
      if (!response.ok()) throw new CliError('API', '知乎素材回查未成功。', { status: response.status() });
      const image = await response.json() as { original_src?: string; src: string };
      return { value: { id: receipt.id, url: image.original_src ?? image.src } };
    },
  });
}
async function saveDraft(context: CapabilityContext<ZhihuSession>, article: ZhihuArticle, remote: z.infer<typeof remoteReferenceSchema>, uploads: Record<string, string>) {
  const page = context.session.page; await openEditor(context.session, remote.id);
  const html = expectedBody(article, uploads);
  await page.getByPlaceholder(TITLE).fill(article.title); await pasteHtml(page, html);
  if (article.cover?.artifact) {
    let input = page.locator('.UploadPicture-wrapper input[type="file"][accept*=".png"]');
    if (!await input.count()) { await page.getByRole('button', { name: '发布设置', exact: true }).click(); input = page.locator('.UploadPicture-wrapper input[type="file"][accept*=".png"]'); }
    await input.setInputFiles(context.artifacts.path(article.cover.artifact));
    await page.getByAltText('封面图', { exact: true }).waitFor({ state: 'visible' });
  }
  if (article.options.declaration === 'ai_assisted') {
    const control = page.getByRole('combobox').filter({ hasText: /无声明|包含 AI 辅助创作/ });
    await control.click(); await page.getByRole('option', { name: /包含 AI 辅助创作/ }).click();
  }
  // Poll only successful reads while autosave is pending. Network/API errors propagate;
  // a fixed delay or the edited DOM cannot prove the server has saved the body.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const draft = await browserJson<ArticleData>(page, `/api/articles/${remote.id}/draft`);
    if (draft.title === article.title && sameBody(html, draft.content)) break;
    if (Date.now() >= deadline) throw new CliError('UNKNOWN', '知乎服务器尚未确认本次草稿内容，请回查原 ID。');
    await page.waitForTimeout(1000);
  }
  await context.remember(remote); return remote;
}
async function publish(context: CapabilityContext<ZhihuSession>, remote: z.infer<typeof remoteReferenceSchema>) {
  const page = context.session.page; await openEditor(context.session, remote.id);
  await page.getByRole('button', { name: '发布', exact: true }).click();
  const confirmation = page.getByRole('button', { name: /^(发布文章|确认发布)$/ }).filter({ visible: true });
  const published = page.waitForURL(url => url.hostname === 'zhuanlan.zhihu.com' && url.pathname === '/p/' + remote.id, { timeout: 60_000 });
  try {
    // Accounts can publish directly or show an asynchronously loaded confirmation dialog.
    const next = await Promise.race([published.then(() => 'published'), confirmation.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'confirmation')]);
    if (next === 'confirmation') { await confirmation.click(); await published; }
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
    if (await page.locator('iframe[src*="captcha"], .Captcha').filter({ visible: true }).count()) throw new CliError('VERIFICATION', '知乎要求安全验证，请在浏览器中完成后回查。', { verification: { kind: 'platform_challenge', strategy: 'inspect', resource: remote } });
    throw new CliError('UNKNOWN', '知乎发表结果未确认，请回查原文章 ID，勿重复提交。');
  }
  const current = await browserJson<ArticleData>(page, '/api/articles/' + remote.id);
  if (current.state !== 'published') throw new CliError('UNKNOWN', '知乎尚未确认公开状态，保留原文章 ID。');
  const article = { kind: 'article', id: remote.id, url: `${ORIGIN}/p/${remote.id}` };
  await context.remember(article); return { status: 'published' as const, remote: article };
}

export function createZhihuPlatform(dependencies: { withBrowser?: typeof withAccountBrowser } = {}) {
  const browser = dependencies.withBrowser ?? withAccountBrowser;
  const acceptance = { offline: true, liveRead: false, liveWrite: false };
  const handler = stepHandler<ZhihuSession>();
  const handlers = {
    allocate: handler({ version: '1', effect: 'remote-write', input: preparedSchema, dependencies: z.strictObject({}), output: remoteReferenceSchema, execute: allocate,
      recover: async (context, _article, _dependencies, saved) => {
        const remote = saved.references.find(reference => reference.kind === 'draft');
        if (!remote) return { verdict: 'indeterminate' as const, evidence: { source: 'draft', message: '缺少本次分配的草稿 ID，不能重新创建。' } };
        await readResource(context.session, { ...remote, kind: 'draft' });
        return { verdict: 'effect_confirmed' as const, value: remote, evidence: { source: 'draft.get', message: '原草稿 ID 可以读取。', reference: remote } };
      } }),
    existing: handler({ version: '1', effect: 'read', input: baselineSchema, dependencies: z.strictObject({}), output: remoteReferenceSchema,
      execute: async (context, base) => { requireVersion(base, await readResource(context.session, base.resource)); await context.remember(base.resource); return base.resource; } }),
    upload: handler({ version: '1', effect: 'remote-write', input: artifactSchema, dependencies: z.object({ draft: remoteReferenceSchema }), output: z.string(),
      execute: async (context, artifact, dependencies) => { await openEditor(context.session, dependencies.draft.id); return (await cachedUpload(context, artifact)).url; },
      recover: async (context, artifact, _dependencies, saved) => {
        const remote = saved.references.find(reference => reference.kind === 'image');
        if (!remote?.url) return { verdict: 'indeterminate' as const, evidence: { source: 'image', message: '缺少已上传图片 ID，不重复上传。' } };
        const receipt = await cachedUpload(context, artifact, async () => ({ id: remote.id, url: remote.url! }));
        return { verdict: 'effect_confirmed' as const, value: receipt.url, evidence: { source: 'image.receipt', message: '沿用已完成上传返回的图片 ID。', reference: remote } };
      } }),
    save: handler({ version: '1', effect: 'remote-write', input: preparedSchema, dependencies: z.object({ draft: remoteReferenceSchema }).catchall(z.string()), output: remoteReferenceSchema,
      execute: (context, article, dependencies) => saveDraft(context, article, dependencies.draft, Object.fromEntries(Object.entries(dependencies).filter(([key]) => key !== 'draft')) as Record<string, string>),
      recover: async (context, article, dependencies) => {
        const remote = dependencies.draft; const current = await readResource(context.session, { ...remote, kind: 'draft' });
        const uploads = Object.fromEntries(Object.entries(dependencies).filter(([key]) => key !== 'draft')) as Record<string, string>;
        if (current.data.title !== article.title || !sameBody(expectedBody(article, uploads), current.data.body)) return { verdict: 'indeterminate' as const, evidence: { source: 'draft.get', message: '原草稿回读尚未匹配本次内容。', reference: remote } };
        return { verdict: 'effect_confirmed' as const, value: remote, evidence: { source: 'draft.get', message: '原草稿已保存本次内容，无需再次填入。', reference: remote } };
      } }),
    result: handler({ version: '1', effect: 'read', input: z.strictObject({}), dependencies: z.object({ save: remoteReferenceSchema }), output: operationResultSchema,
      execute: async (context, _input, dependencies) => {
        const snapshot = await readResource(context.session, { ...dependencies.save, kind: 'draft' });
        return { status: 'draft_saved' as const, remote: snapshot.resource, observation: { state: snapshot.state, remote: snapshot.resource, snapshot } };
      } }),
    publish: handler({ version: '1', effect: 'remote-write', input: z.strictObject({}), dependencies: z.object({ save: remoteReferenceSchema }), output: operationResultSchema,
      execute: (context, _input, dependencies) => publish(context, dependencies.save),
      recover: async (context, _input, dependencies) => {
        const remote = { kind: 'article' as const, id: dependencies.save.id, url: `${ORIGIN}/p/${dependencies.save.id}` };
        const snapshot = await readResource(context.session, remote);
        if (snapshot.state !== 'published') return { verdict: 'indeterminate' as const, evidence: { source: 'article.get', message: '原文章尚未确认公开，草稿存在不允许再次发表。', reference: remote } };
        return { verdict: 'effect_confirmed' as const, value: { status: 'published' as const, remote }, evidence: { source: 'article.get', message: '原 ID 的公开响应确认发表，无需再次提交。', reference: remote } };
      } }),
  };
  const prepare = (raw: { file: string; options?: object }, context: ContentPreparation) => prepareArticle(raw, context, 'zhihu', zhihuOptionsSchema, async (document, options) => {
    const title = documentTitle(document, options);
    if (Array.from(title).length > 100) throw new CliError('INPUT', '知乎标题最多 100 字，不自动截断。');
    const assets = await documentAssets(document, options);
    if (assets.some(asset => !asset.artifact)) throw new CliError('INPUT', '知乎正文图片请使用本地文件。');
    const cover = options.cover ? await assetFrom(options.cover, document) : undefined;
    if (cover && !cover.artifact) throw new CliError('INPUT', '知乎封面请使用本地文件。');
    const { renderStyledContent } = await import('@wenyan-md/core/wrapper');
    const html = await renderStyledContent(omitRepeatedTitle(document.markdown, title), { themeId: 'default', hlThemeId: 'github', isMacStyle: false, isAddFootnote: false });
    const window = new JSDOM('').window; const body = createDOMPurify(window).sanitize(html, { FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form'] }); window.close();
    return { title, body, format: 'text/html', assets, cover, options: { declaration: options.declaration ?? 'none' } };
  });
  const writing = (id: string, shouldPublish: boolean) => workflowCapability<ZhihuSession>()({
    id, description: shouldPublish ? '创建知乎专栏草稿、上传图片并发表后回查原 ID' : '使用专栏原生编辑器保存并从服务器回读草稿', acceptance, successStates: shouldPublish ? ['published'] : ['draft_saved'],
    input: articleInputSchema(zhihuOptionsSchema), prepared: preparedSchema, output: operationResultSchema, prepare, preflight: async () => undefined, handlers,
    compile: article => {
      const uploads = [...new Map(article.assets.map(asset => [uploadStep(asset.artifact!), asset.artifact!])).entries()];
      const payload = JSON.parse(JSON.stringify(article));
      return { id, version: '1', resultStep: shouldPublish ? 'publish' : 'result', steps: [
        { id: 'draft', handler: 'allocate', version: '1', needs: [], input: payload },
        ...uploads.map(([id, artifact]) => ({ id, handler: 'upload', version: '1', needs: ['draft'], input: artifact })),
        { id: 'save', handler: 'save', version: '1', needs: ['draft', ...uploads.map(([id]) => id)], input: payload },
        { id: shouldPublish ? 'publish' : 'result', handler: shouldPublish ? 'publish' : 'result', version: '1', needs: ['save'], input: {} },
      ] };
    },
    inspect: async ({ session }, remote) => { const snapshot = await readResource(session, { ...remote, kind: remote.kind === 'draft' ? 'draft' : 'article' }); return { state: snapshot.state, remote: snapshot.resource, snapshot }; },
  });
  return definePlatform<ZhihuSession>({
    id: 'zhihu', name: '知乎', driver: { id: 'zhihu.browser', version: '1' },
    login: directory => browser({ directory }, async (_context, page) => (await zhihuProfile(page, true)).profile),
    withSession: (account, action) => browser(account, async (_context, page) => action(await zhihuProfile(page))),
    capabilities: [writing('draft.create', false), writing('content.publish', true),
      readCapability<ZhihuSession>()({ id: 'resource.get', description: '核对账号并读取已有草稿或文章及版本', acceptance, input: z.strictObject({ resource: resourceSchema }), output: snapshotSchema, execute: ({ session }, input) => readResource(session, input.resource) }),
      workflowCapability<ZhihuSession>()({ id: 'draft.publish', description: '核对版本后发表原知乎草稿，不分配新文章', acceptance, successStates: ['published'], input: z.strictObject({ base: snapshotSchema }), prepared: z.object({ base: baselineSchema }), output: operationResultSchema,
        prepare: async input => ({ base: resourceBaseline(input.base) }), preflight: async () => undefined, handlers,
        compile: input => ({ id: 'draft.publish', version: '1', resultStep: 'publish', steps: [ { id: 'save', handler: 'existing', version: '1', needs: [], input: input.base }, { id: 'publish', handler: 'publish', version: '1', needs: ['save'], input: {} } ] }),
      }),
      readCapability<ZhihuSession>()({ id: 'article.list', description: '查询当前账号的专栏文章', acceptance, input: listInputSchema, output: resourceListSchema,
        execute: async ({ session }, input) => {
          const result = await browserJson<{ data: { id: string; title: string }[] }>(session.page, `/api/v4/members/${encodeURIComponent(session.urlToken)}/articles?offset=0&limit=${input.limit}`);
          return { items: result.data.map(article => ({ resource: { kind: 'article', id: String(article.id), url: `${ORIGIN}/p/${article.id}` }, title: article.title })) };
        } }),
    ],
  });
}
