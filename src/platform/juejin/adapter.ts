import { operationResultSchema } from '../../core/types.js';
import { dirname } from 'node:path';
import { z } from 'zod';
import { definePlatform } from '../../core/platform.js';
import { readCapability, writeCapability } from '../../core/capability.js';
import { listInputSchema, resourceListSchema } from '../../core/schemas.js';
import type { AccountScope, CapabilityContext, OperationResult } from '../../core/types.js';
import { assetFrom, documentAssets, documentTitle, articleInputSchema, prepareArticle, preflightArticle, preparedArticleSchema, type ArticleDocument } from '../../content/document.js';
import { CliError } from '../../shared/errors.js';
import { JuejinClient } from './client.js';
import { JuejinHttp } from './http.js';
import { DraftService } from './draft-service.js';
import { ImageUploader } from './imagex.js';
import { SessionStore, cookieHeader, login, type UserProfile } from './session.js';
import { ensureBrowser } from '../../runtime/managed-browser.js';

export const juejinOptionsSchema = z.object({
  title: z.string().optional(), brief: z.string().min(50).max(100).optional(), summary: z.string().min(50).max(100).optional(),
  category: z.string().min(1), tags: z.array(z.string().min(1)).min(1), columns: z.array(z.string()).optional(),
  cover: z.string().optional(), images: z.array(z.string()).optional(),
});
const optionsSchema = z.object({ file: z.string(), brief: z.string(), category: z.string(), tags: z.array(z.string()), cover: z.string(), columns: z.array(z.string()) });
const preparedSchema = preparedArticleSchema.extend({ options: optionsSchema });
type JuejinArticle = z.infer<typeof preparedSchema>;
interface JuejinSession { profile: { id: string; name: string }; client: JuejinClient; uploader: ImageUploader }

async function render(document: ArticleDocument, options: z.infer<typeof juejinOptionsSchema>): Promise<JuejinArticle> {
  const title = documentTitle(document, options);
  const brief = options.brief ?? options.summary;
  if (!brief) throw new CliError('INPUT', '掘金需要 50–100 字摘要。');
  const assets = await documentAssets(document, options);
  const cover = options.cover ? await assetFrom(options.cover, document) : undefined;
  return { title, body: document.markdown, format: 'text/markdown', assets, cover, options: {
    file: document.file, brief, category: options.category, tags: options.tags, cover: options.cover ?? '', columns: options.columns ?? [],
  } };
}

async function write(context: CapabilityContext<JuejinSession>, article: JuejinArticle, publish: boolean): Promise<OperationResult> {
  const { client, uploader } = context.session;
  const drafts = new DraftService(client, uploader);
  const draft = await context.step('draft.create', async () => {
    const document = { content: article.body, metadata: {}, directory: dirname(article.options.file) };
    const plan = await drafts.prepareDocument(document, {
      title: article.title, brief: article.options.brief, category: article.options.category,
      tags: article.options.tags, cover: article.options.cover,
    });
    const input = await drafts.uploadAssets(plan);
    return { id: (await client.createDraft(input)).id };
  });
  await context.remember({ kind: 'draft', id: draft.id });
  if (!publish) return { status: 'draft_saved', remote: { kind: 'draft', id: draft.id, url: 'https://juejin.cn/editor/drafts/' + draft.id } };
  const result = await context.step('article.publish', () => client.publish(draft.id, article.options.columns));
  return { status: 'submitted', remote: { kind: 'article', id: result.article_id, url: 'https://juejin.cn/post/' + result.article_id } };
}

const acceptance = { offline: true, liveRead: false, liveWrite: false };
export function createJuejinPlatform(dependencies: { fetch?: typeof globalThis.fetch } = {}) {
  const writeDefinition = writeCapability<JuejinSession>();
  const readDefinition = readCapability<JuejinSession>();
  const writing = (id: string, description: string, publish: boolean) => writeDefinition({
    id, description, acceptance, successStates: publish ? ['submitted', 'published'] : ['draft_saved'], input: articleInputSchema(juejinOptionsSchema), prepared: preparedSchema, output: operationResultSchema,
    prepare: async raw => prepareArticle(raw, 'juejin', juejinOptionsSchema, render),
    preflight: preflightArticle, execute: (context, article) => write(context, article, publish),
    inspect: async ({ session }, remote) => {
      if (remote.kind === 'draft') { await session.client.draft(remote.id); return { status: 'draft_saved', remote }; }
      await session.client.article(remote.id);
      return { status: 'published', remote };
    },
  });
  return definePlatform({
    id: 'juejin', name: '掘金', driver: { id: 'juejin.web', version: '2' },
    login: async (directory: string) => {
      await ensureBrowser();
      const profile = await login(new SessionStore(directory));
      return { id: profile.user_id, name: profile.user_name };
    },
    withSession: async <T>(account: AccountScope, action: (session: JuejinSession) => Promise<T>) => {
      const cookies = await new SessionStore(account.directory).load();
      const http = new JuejinHttp({ cookie: cookieHeader(cookies), fetch: dependencies.fetch });
      const profile = await http.data<UserProfile>('/user_api/v1/user/get');
      return action({ profile: { id: profile.user_id, name: profile.user_name }, client: new JuejinClient(http), uploader: new ImageUploader(http) });
    },
    capabilities: [
      writing('draft.create', '上传图片并创建掘金草稿', false),
      writing('content.publish', '创建草稿并提交到指定专栏', true),
      readDefinition({ id: 'draft.list', description: '查询掘金草稿', acceptance, input: listInputSchema, output: resourceListSchema,
        execute: async ({ session }, input) => ({ items: (await session.client.drafts(1, input.limit)).items.map(draft => ({ resource: { kind: 'draft', id: draft.id }, title: draft.title })) }) }),
      readDefinition({ id: 'article.list', description: '查询自己的掘金文章', acceptance, input: listInputSchema, output: resourceListSchema,
        execute: async ({ session }, input) => ({ items: (await session.client.articles(1, input.limit)).items.map(article => ({ resource: { kind: 'article', id: article.article_info.article_id, url: 'https://juejin.cn/post/' + article.article_info.article_id }, title: article.article_info.title })) }) }),
      readDefinition({ id: 'juejin.category.list', description: '查询发布可用的分类 ID 和名称', acceptance, input: z.strictObject({}), output: resourceListSchema,
        execute: async ({ session }) => ({ items: (await session.client.categories()).map(category => ({ resource: { kind: 'category', id: category.category_id }, title: category.category_name })) }) }),
      readDefinition({ id: 'juejin.tag.search', description: '查询标签 ID 和精确名称', acceptance, input: z.strictObject({ keyword: z.string().min(1) }), output: resourceListSchema,
        execute: async ({ session }, input) => ({ items: (await session.client.findTags(input.keyword)).map(tag => ({ resource: { kind: 'tag', id: tag.tag_id }, title: tag.tag_name })) }) }),
      readDefinition({ id: 'juejin.column.list', description: '查询当前账号的专栏', acceptance, input: listInputSchema, output: resourceListSchema,
        execute: async ({ session }, input) => ({ items: (await session.client.columns(1, input.limit)).items.map(column => ({ resource: { kind: 'column', id: column.column.column_id, url: 'https://juejin.cn/column/' + column.column.column_id }, title: column.column_version.title })) }) }),
    ],
  });
}
