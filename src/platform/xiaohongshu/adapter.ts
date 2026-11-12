import { errors, type Page } from 'playwright';
import type { AccountProfile, ArticleDocument, OperationContext, OperationResult, PlatformAdapter, PreparedArticle, RemoteReference } from '../../core/types.js';
import { assetFrom, documentAssets, documentTitle, listOption, textOption } from '../../content/document.js';
import { omitRepeatedTitle } from '../../content/markdown.js';
import { withAccountBrowser, navigatePlatform } from '../../runtime/managed-browser.js';
import type { AccountStore } from '../../runtime/accounts.js';
import { CliError } from '../../shared/errors.js';

const HOME = 'https://www.xiaohongshu.com/explore';
const PUBLISH = 'https://creator.xiaohongshu.com/publish/publish';
const PROFILE_LINK = '.main-container .user .link-wrapper a.link-wrapper';
const EDITOR = '.ql-editor[contenteditable="true"], .tiptap[contenteditable="true"]';

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

export async function prepareXhs(document: ArticleDocument, options: Record<string, unknown>): Promise<PreparedArticle> {
  const title = documentTitle(document, options);
  const body = textOption(options, 'content', omitRepeatedTitle(document.markdown, title)).trim();
  if (Array.from(title).length > 20) throw new CliError('INPUT', '小红书标题最多 20 字，请提供 platforms.xiaohongshu.title。');
  if (!body || Array.from(body).length > 1000) throw new CliError('INPUT', '小红书正文须为 1–1000 字，请提供 platforms.xiaohongshu.content。');
  const assets = await documentAssets(document, options);
  const cover = textOption(options, 'cover');
  if (cover && !assets.some(asset => asset.source === cover)) assets.unshift(await assetFrom(cover, document));
  if (!assets.length || assets.length > 18) throw new CliError('INPUT', '小红书图文需要 1–18 张图片。');
  if (assets.some(asset => !asset.path)) throw new CliError('INPUT', '小红书图片请使用本地文件，避免发布时下载远程内容发生变化。');
  const tags = listOption(options, 'tags');
  if (tags.length > 10) throw new CliError('INPUT', '小红书话题最多 10 个，不会自动截断。');
  const visibility = textOption(options, 'visibility', '公开可见');
  if (!['公开可见', '仅自己可见', '仅互关好友可见'].includes(visibility)) throw new CliError('INPUT', '小红书可见范围不受支持。');
  return { title, body, format: 'image-text', assets, options: { tags, visibility } };
}

async function fillXhs(page: Page, article: PreparedArticle): Promise<void> {
  await navigatePlatform(page, PUBLISH);
  if (new URL(page.url()).pathname.includes('login')) throw new CliError('AUTH', '小红书创作者中心需要登录，请运行 wm auth login xiaohongshu。');
  const tab = page.locator('div.creator-tab').filter({ hasText: '上传图文', visible: true }).first();
  await tab.click();
  await page.locator('input[type="file"]').first().setInputFiles(article.assets.map(asset => asset.path!));
  await page.waitForFunction(count => document.querySelectorAll('.img-preview-area .pr').length >= count, article.assets.length, { timeout: 90_000 });
  await page.locator('div.d-input input').fill(article.title);
  const editor = page.locator(EDITOR).first();
  await editor.fill(article.body);
  for (const tag of article.options.tags as string[]) {
    await editor.press('End');
    await editor.press('Enter');
    await editor.pressSequentially('#' + tag);
    const topic = page.locator('#creator-editor-topic-container .item').filter({ hasText: tag }).first();
    await topic.click();
    await editor.press('Space');
    const present = await editor.locator('a[data-topic], a[data-topic-id], .tiptap-topic, [data-type="topic"]').filter({ hasText: tag }).count();
    if (!present) throw new CliError('PROTOCOL', '话题未成为平台正式话题：' + tag);
  }
  const visibility = article.options.visibility as string;
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
  return { status: 'submitted', remote: { kind: 'article', id, url: 'https://www.xiaohongshu.com/explore/' + id } };
}

async function publishXhs(context: OperationContext, article: PreparedArticle): Promise<OperationResult> {
  return withAccountBrowser(context.account, async (_browser, page) => {
    await context.account.verify(await xhsProfile(page));
    return context.step('note.publish', async () => {
      await fillXhs(page, article);
      return submitXhs(page);
    });
  });
}

async function ownNotes(page: Page, account: AccountStore, limit: number) {
  await account.verify(await xhsProfile(page));
  await page.locator('.note-item, .feeds-container').first().waitFor({ state: 'attached' });
  return page.locator('.note-item').evaluateAll((cards, maximum) => cards.slice(0, maximum).map(card => {
    const link = card.querySelector<HTMLAnchorElement>('a.cover, a[href*="/explore/"], a[href*="/user/profile/"]');
    const url = link?.href ?? '';
    const id = url.match(/\/([a-f0-9]{24})(?:\?|$)/)?.[1];
    return { id, title: card.querySelector('.title')?.textContent?.trim() ?? '', url };
  }), limit);
}

export function createXiaohongshuAdapter(): PlatformAdapter {
  return {
    id: 'xiaohongshu', name: '小红书', driver: 'xiaohongshu.browser', version: '1',
    operations: { publish: { description: '上传图集并提交图文笔记，捕获真实发布响应', run: publishXhs } },
    lists: { article: { description: '查询自己的公开笔记', run: (account, limit) => withAccountBrowser(account, (_browser, page) => ownNotes(page, account, limit)) } },
    prepare: prepareXhs,
    login: account => withAccountBrowser(account, async (_browser, page) => {
      const profile = await xhsProfile(page, true);
      await navigatePlatform(page, PUBLISH);
      if (new URL(page.url()).pathname.includes('login')) {
        process.stderr.write('请在创作者中心完成此次登录验证。\n');
        await page.waitForURL(url => !url.pathname.includes('login'), { timeout: 300_000 });
      }
      return profile;
    }),
    status: account => withAccountBrowser(account, async (_browser, page) => account.verify(await xhsProfile(page))),
    inspect: (account, remote: RemoteReference) => withAccountBrowser(account, async (_browser, page) => {
      const notes = await ownNotes(page, account, 100);
      if (remote.id && notes.some(note => note.id === remote.id)) return { status: 'published', remote };
      return { status: 'submitted', remote, message: '自己的公开笔记列表尚未包含此 ID，可能仍在审核。' };
    }),
  };
}
