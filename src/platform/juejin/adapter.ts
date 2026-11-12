import { dirname } from 'node:path';
import type { ArticleDocument, OperationContext, OperationResult, PlatformAdapter, PreparedArticle } from '../../core/types.js';
import { assetFrom, documentAssets, documentTitle, listOption, textOption } from '../../content/document.js';
import { CliError } from '../../shared/errors.js';
import { JuejinClient } from './client.js';
import { JuejinHttp } from './http.js';
import { DraftService } from './draft-service.js';
import { ImageUploader } from './imagex.js';
import { SessionStore, cookieHeader, login, verifySession } from './session.js';
import { ensureBrowser } from '../../runtime/managed-browser.js';
import type { AccountStore } from '../../runtime/accounts.js';

async function clientFor(account: AccountStore) {
  const cookies = await new SessionStore(account.directory).load();
  const http = new JuejinHttp({ cookie: cookieHeader(cookies) });
  return { client: new JuejinClient(http), uploader: new ImageUploader(http) };
}

async function prepare(document: ArticleDocument, options: Record<string, unknown>): Promise<PreparedArticle> {
  const title = documentTitle(document, options);
  const brief = textOption(options, 'brief', textOption(options, 'summary'));
  if (brief.length < 50 || brief.length > 100) throw new CliError('INPUT', '掘金需要 50–100 字摘要。');
  const category = textOption(options, 'category');
  const tags = listOption(options, 'tags');
  if (!category || !tags.length) throw new CliError('INPUT', '掘金需要分类和至少一个标签。');
  const assets = await documentAssets(document, options);
  const coverSource = textOption(options, 'cover');
  const cover = coverSource ? await assetFrom(coverSource, document) : undefined;
  return { title, body: document.markdown, format: 'markdown', assets, cover, options: {
    file: document.file, brief, category, tags, cover: coverSource, columns: listOption(options, 'columns'),
  } };
}

async function write(context: OperationContext, article: PreparedArticle, publish: boolean): Promise<OperationResult> {
  const { client, uploader } = await clientFor(context.account);
  const drafts = new DraftService(client, uploader);
  const draft = await context.step('draft.create', async () => {
    // Use the persisted plan, not a second file read after a potentially long login.
    const document = { content: article.body, metadata: {}, directory: dirname(article.options.file as string) };
    const plan = await drafts.prepareDocument(document, {
      title: article.title, brief: article.options.brief as string, category: article.options.category as string,
      tags: article.options.tags as string[], cover: article.options.cover as string,
    });
    const input = await drafts.uploadAssets(plan);
    return { id: (await client.createDraft(input)).id };
  });
  await context.remember({ kind: 'draft', id: draft.id });
  if (!publish) return { status: 'draft_saved', remote: { kind: 'draft', id: draft.id, url: 'https://juejin.cn/editor/drafts/' + draft.id } };
  const result = await context.step('article.publish', () => client.publish(draft.id, article.options.columns as string[]));
  return { status: 'submitted', remote: { kind: 'article', id: result.article_id, url: 'https://juejin.cn/post/' + result.article_id } };
}

export function createJuejinAdapter(): PlatformAdapter {
  return {
    id: 'juejin', name: '掘金', driver: 'juejin.web', version: '1',
    operations: {
      draft: { description: '上传图片并创建掘金草稿', run: (context, article) => write(context, article, false) },
      publish: { description: '创建草稿并发布到指定专栏', run: (context, article) => write(context, article, true) },
    },
    lists: {
      draft: { description: '查询掘金草稿', run: async (account, limit) => (await clientFor(account)).client.drafts(1, limit) },
      article: { description: '查询自己的掘金文章', run: async (account, limit) => (await clientFor(account)).client.articles(1, limit) },
    },
    prepare,
    login: async account => {
      await ensureBrowser();
      const profile = await login(new SessionStore(account.directory));
      return { id: profile.user_id, name: profile.user_name };
    },
    status: async account => {
      const profile = await verifySession(await new SessionStore(account.directory).load());
      return account.verify({ id: profile.user_id, name: profile.user_name });
    },
    inspect: async (account, remote) => {
      if (!remote.id) throw new CliError('INPUT', '掘金回查需要远端 ID。');
      const { client } = await clientFor(account);
      if (remote.kind === 'draft') { await client.draft(remote.id); return { status: 'draft_saved', remote }; }
      await client.article(remote.id);
      return { status: 'published', remote };
    },
  };
}
