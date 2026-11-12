import type { ArtifactReader } from '../../core/content.js';
import { resourceSnapshot } from '../../content/resources.js';
import { operationResultSchema, resourceSnapshotSchema, remoteReferenceSchema } from '../../core/types.js';
import { errors, type Page } from 'playwright';
import { z } from 'zod';
import type { AccountProfile, CapabilityContext, OperationResult } from '../../core/types.js';
import { definePlatform } from '../../core/platform.js';
import { readCapability, writeCapability } from '../../core/capability.js';
import { listInputSchema, resourceListSchema } from '../../core/schemas.js';
import { assetFrom, documentAssets, documentTitle, articleInputSchema, prepareArticle, preparedArticleSchema, type ArticleDocument } from '../../content/document.js';
import { omitRepeatedTitle } from '../../content/markdown.js';
import { withAccountBrowser, navigatePlatform } from '../../runtime/managed-browser.js';
import { CliError } from '../../shared/errors.js';

const HOME = 'https://www.xiaohongshu.com/explore';
const PUBLISH = 'https://creator.xiaohongshu.com/publish/publish';
const PROFILE_LINK = '.main-container .user .link-wrapper a.link-wrapper';
const EDITOR = '.ql-editor[contenteditable="true"], .tiptap[contenteditable="true"]';
const LIMITS = { title: 20, content: 1000, images: 18, tags: 10 };

// Adapted from autoclaw-cc/xiaohongshu-skills (MIT), pinned in THIRD_PARTY_NOTICES.
// Keep the site's own editor and submission events; never extract or forge request signatures.
export async function xhsProfile(page: Page, waitForLogin = false): Promise<AccountProfile> {
  await navigatePlatform(page, HOME);
  // Responsive navigation renders duplicate account links; only the visible entry is interactive.
  const link = page.locator(PROFILE_LINK).filter({ visible: true }).first();
  if (waitForLogin) process.stderr.write('请在打开的小红书浏览器中完成扫码登录。\n');
  try { await link.waitFor({ state: 'visible', timeout: waitForLogin ? 300_000 : 20_000 }); }
  catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
    throw new CliError('AUTH', '小红书尚未登录或需要验证，请运行 wm auth login xiaohongshu。');
  }
  const href = await link.getAttribute('href');
  const id = href?.match(/\/user\/profile\/([a-f0-9]+)/)?.[1];
  if (!id) throw new CliError('PROTOCOL', '小红书账号入口未返回用户 ID。');
  await navigatePlatform(page, new URL(href!, HOME).href);
  const name = (await page.locator('.user-name').filter({ visible: true }).first().innerText()).trim();
  return { id, name };
}

export const xhsOptionsSchema = z.object({
  title: z.string().meta({ maxCodePoints: LIMITS.title }).optional(), content: z.string().meta({ minCodePoints: 1, maxCodePoints: LIMITS.content }).optional(), cover: z.string().optional(), images: z.array(z.string()).optional(),
  tags: z.array(z.string()).max(LIMITS.tags).optional(), visibility: z.enum(['公开可见', '仅自己可见', '仅互关好友可见']).optional(),
});
const preparedSchema = preparedArticleSchema.extend({ options: z.object({ tags: z.array(z.string()), visibility: z.string() }) });
type XhsArticle = z.infer<typeof preparedSchema>;
interface XhsSession { profile: AccountProfile; page: Page }

export async function prepareXhs(document: ArticleDocument, options: z.infer<typeof xhsOptionsSchema>): Promise<XhsArticle> {
  const title = documentTitle(document, options);
  const body = (options.content ?? omitRepeatedTitle(document.markdown, title)).trim();
  if (Array.from(title).length > LIMITS.title) throw new CliError('INPUT', '小红书标题最多 20 字，请提供 platforms.xiaohongshu.title。');
  if (!body || Array.from(body).length > LIMITS.content) throw new CliError('INPUT', '小红书正文须为 1–1000 字，请提供 platforms.xiaohongshu.content。');
  const assets = await documentAssets(document, options);
  const cover = options.cover;
  if (cover && !assets.some(asset => asset.source === cover)) assets.unshift(await assetFrom(cover, document));
  if (!assets.length || assets.length > LIMITS.images) throw new CliError('INPUT', '小红书图文需要 1–18 张图片。');
  if (assets.some(asset => !asset.artifact)) throw new CliError('INPUT', '小红书图片请使用本地文件，避免发布时下载远程内容发生变化。');
  const tags = options.tags ?? [];
  const visibility = options.visibility ?? '公开可见';
  return { title, body, format: 'xiaohongshu/image-text', assets, options: { tags, visibility } };
}

async function fillXhs(page: Page, article: XhsArticle, artifacts: ArtifactReader): Promise<void> {
  await navigatePlatform(page, PUBLISH);
  if (new URL(page.url()).pathname.includes('login')) throw new CliError('AUTH', '小红书创作者中心需要登录，请运行 wm auth login xiaohongshu。', { outcome: 'rejected' });
  const tab = page.locator('div.creator-tab').filter({ hasText: '上传图文', visible: true }).first();
  await tab.click();
  await page.locator('input[type="file"]').first().setInputFiles(article.assets.map(asset => artifacts.path(asset.artifact!)));
  await page.waitForFunction(count => document.querySelectorAll('.img-preview-area .pr').length >= count, article.assets.length, { timeout: 90_000 });
  await page.locator('div.d-input input').fill(article.title);
  const editor = page.locator(EDITOR).first();
  await editor.fill(article.body);
  for (const tag of article.options.tags) {
    await editor.press('End');
    await editor.press('Enter');
    await editor.pressSequentially('#' + tag);
    const topic = page.locator('#creator-editor-topic-container .item').filter({ hasText: tag }).first();
    await topic.click();
    await editor.press('Space');
    const present = await editor.locator('a[data-topic], a[data-topic-id], .tiptap-topic, [data-type="topic"]').filter({ hasText: tag }).count();
    if (!present) throw new CliError('PROTOCOL', '话题未成为平台正式话题：' + tag);
  }
  const visibility = article.options.visibility;
  if (visibility !== '公开可见') {
    await page.locator('div.permission-card-wrapper div.d-select-content').click();
    await page.locator('div.d-options-wrapper .custom-option').getByText(visibility, { exact: true }).click();
  }
  const error = page.locator('div.edit-container div.length-error');
  if (await error.isVisible()) throw new CliError('INPUT', (await error.innerText()).trim());
}

interface NoteResponse { code: number; success?: boolean; msg?: string; data?: { note_id?: string; id?: string } }

export async function submitXhs(page: Page, timeoutMs = 60_000): Promise<OperationResult> {
  // Capture the actual POST result before triggering the button. A URL change alone proves no note ID.
  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.hostname.endsWith('.xiaohongshu.com') && /\/note(?:\/?$|\?)/.test(url.pathname) && response.request().method() === 'POST';
  }, { timeout: timeoutMs });
  try {
    const widget = page.locator('xhs-publish-btn[is-publish="true"]');
    if (await widget.count()) {
      if (await widget.getAttribute('submit-disabled') === 'true') throw new CliError('INPUT', '小红书发布按钮不可用。', { outcome: 'rejected' });
      await widget.dispatchEvent('publish');
    } else {
      await page.locator('.publish-page-publish-btn button.bg-red').click();
    }
  } catch (error) {
    // The pending observer is read-only; consume its eventual timeout if no click was possible.
    void responsePromise.catch(() => undefined);
    throw error;
  }
  const response = await responsePromise;
  if (!response.ok()) throw new CliError('NETWORK', '小红书发布响应异常，结果需要核对。');
  const result = await response.json() as NoteResponse;
  if (result.code !== 0 && result.success !== true) {
    throw new CliError('API', result.msg ?? '小红书拒绝发布。', { platform_code: result.code, outcome: 'rejected' });
  }
  const id = result.data?.note_id ?? result.data?.id;
  if (!id) return { status: 'submitted', message: '平台已受理，但未返回笔记 ID；请查询自己的文章，勿重复提交。' };
  return { status: 'submitted', remote: { kind: 'note', id, url: 'https://www.xiaohongshu.com/explore/' + id } };
}

async function publishXhs(context: CapabilityContext<XhsSession>, article: XhsArticle): Promise<OperationResult> {
  await fillXhs(context.session.page, article, context.artifacts);
  const result = await submitXhs(context.session.page);
  if (result.remote) await context.remember(result.remote);
  return result;
}

async function ownNotes(page: Page, profile: AccountProfile, limit: number) {
  await navigatePlatform(page, 'https://www.xiaohongshu.com/user/profile/' + profile.id);
  await page.locator('.note-item, .feeds-container').first().waitFor({ state: 'attached' });
  return page.locator('.note-item').evaluateAll((cards, maximum) => cards.slice(0, maximum).map(card => {
    const link = card.querySelector<HTMLAnchorElement>('a.cover, a[href*="/explore/"], a[href*="/user/profile/"]');
    const url = link?.href ?? '';
    const id = url.match(/\/([a-f0-9]{24})(?:\?|$)/)?.[1];
    if (!id) throw new Error('笔记卡片未提供稳定 ID。');
    return { id, title: card.querySelector('.title')?.textContent?.trim() ?? '', url: 'https://www.xiaohongshu.com/explore/' + id };
  }), limit);
}

export function createXiaohongshuPlatform(dependencies: { withBrowser?: typeof withAccountBrowser } = {}) {
  const browser = dependencies.withBrowser ?? withAccountBrowser;
  const acceptance = { offline: true, liveRead: false, liveWrite: false };
  return definePlatform<XhsSession>({
    id: 'xiaohongshu', name: '小红书', driver: { id: 'xiaohongshu.browser', version: '5' },
    login: directory => browser({ directory }, async (_context, page) => {
      const profile = await xhsProfile(page, true);
      await navigatePlatform(page, PUBLISH);
      if (new URL(page.url()).pathname.includes('login')) {
        process.stderr.write('请在创作者中心完成此次登录验证。\n');
        await page.waitForURL(url => !url.pathname.includes('login'), { timeout: 300_000 });
      }
      return profile;
    }),
    withSession: (account, action) => browser(account, async (_context, page) => action({ profile: await xhsProfile(page), page })),
    capabilities: [
      writeCapability<XhsSession>()({
        successStates: ['submitted', 'published'], id: 'content.publish', description: '上传图集、正式话题与可见范围并提交笔记', acceptance,
        input: articleInputSchema(xhsOptionsSchema), prepared: preparedSchema, output: operationResultSchema,
        prepare: async (raw, context) => prepareArticle(raw, context, 'xiaohongshu', xhsOptionsSchema, prepareXhs),
        preflight: async () => undefined, execute: publishXhs,
        recover: async (_context, _article, saved) => {
          const remote = saved.references.find(reference => reference.kind === 'note');
          if (!remote) return { verdict: 'indeterminate' as const, evidence: { source: 'note', message: '缺少本次提交的笔记 ID，不能按标题匹配或重复发布。' } };
          return { verdict: 'effect_confirmed' as const, value: { status: 'submitted' as const, remote }, evidence: { source: 'note_submission_receipt', message: '该步骤已保存实际提交响应的笔记 ID，公开展示另行回查。', reference: remote } };
        },
        probe: async ({ page }) => {
          await navigatePlatform(page, PUBLISH);
          if (new URL(page.url()).pathname.includes('login')) return { state: 'unavailable', reason: '创作者中心需要登录。', action: 'login' };
          return { state: 'unknown', reason: '创作者中心会话可用，填写时检查实际发布前置条件。' };
        },
        inspect: async ({ session }, remote) => {
          const notes = await ownNotes(session.page, session.profile, 100);
          if (notes.some(note => note.id === remote.id)) return { state: 'published', remote };
          return { state: 'submitted', remote, message: '自己的公开笔记列表尚未包含此 ID，可能仍在审核。' };
        },
      }),
      readCapability<XhsSession>()({
        id: 'resource.get', description: '按稳定 ID 回查自己的公开笔记列表记录；不将列表缺失推断为删除', acceptance,
        input: z.strictObject({ resource: remoteReferenceSchema.extend({ kind: z.literal('note') }) }), output: resourceSnapshotSchema,
        execute: async ({ session }, input) => {
          const note = (await ownNotes(session.page, session.profile, 100)).find(note => note.id === input.resource.id);
          if (!note) return resourceSnapshot({ kind: 'note', id: input.resource.id }, 'unknown', { reason: 'not_in_current_own_list' });
          return resourceSnapshot({ kind: 'note', id: note.id, url: note.url }, 'published', { title: note.title });
        },
      }),
      readCapability<XhsSession>()({
        id: 'article.list', description: '查询自己的公开笔记', acceptance, input: listInputSchema, output: resourceListSchema,
        execute: async ({ session }, input) => ({ items: (await ownNotes(session.page, session.profile, input.limit)).map(note => ({ resource: { kind: 'note', id: note.id, url: note.url }, title: note.title })) }),
      }),
    ],
  });
}
