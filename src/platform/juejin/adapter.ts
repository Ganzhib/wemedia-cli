import { remoteReferenceSchema, operationResultSchema } from '../../core/types.js';
import { z } from 'zod';
import { definePlatform } from '../../core/platform.js';
import { readCapability, workflowCapability } from '../../core/capability.js';
import { listInputSchema, resourceListSchema } from '../../core/schemas.js';
import type { AccountScope, CapabilityContext } from '../../core/types.js';
import { assetFrom, documentAssets, documentTitle, articleInputSchema, prepareArticle, preparedArticleSchema, type ArticleDocument } from '../../content/document.js';
import { artifactSchema } from '../../core/content.js';
import { stepHandler } from '../../core/workflow.js';
import { rewriteImages, scanImages, localImagePath } from '../../content/markdown.js';
import { CliError } from '../../shared/errors.js';
import { JuejinClient } from './client.js';
import { JuejinHttp } from './http.js';
import { DraftService } from './draft-service.js';
import { ImageUploader, validateImageMetadata } from './imagex.js';
import { SessionStore, cookieHeader, login, type UserProfile } from './session.js';
import { ensureBrowser } from '../../runtime/managed-browser.js';

export const juejinOptionsSchema = z.object({
  title: z.string().optional(), brief: z.string().min(50).max(100).optional(), summary: z.string().min(50).max(100).optional(),
  category: z.string().min(1), tags: z.array(z.string().min(1)).min(1), columns: z.array(z.string()).optional(),
  cover: z.string().optional(), images: z.array(z.string()).optional(),
});
const optionsSchema = z.object({ brief: z.string(), category: z.string(), tags: z.array(z.string()), cover: z.string(), columns: z.array(z.string()) });
const preparedSchema = preparedArticleSchema.extend({ options: optionsSchema });
type JuejinArticle = z.infer<typeof preparedSchema>;
interface JuejinSession { profile: { id: string; name: string }; client: JuejinClient; uploader: ImageUploader }

async function render(document: ArticleDocument, options: z.infer<typeof juejinOptionsSchema>): Promise<JuejinArticle> {
  const title = documentTitle(document, options);
  const brief = options.brief ?? options.summary;
  if (!brief) throw new CliError('INPUT', '掘金需要 50–100 字摘要。');
  const assets = await documentAssets(document, options);
  const cover = options.cover ? await assetFrom(options.cover, document) : undefined;
  for (const asset of [...assets, ...(cover ? [cover] : [])]) if (asset.artifact) validateImageMetadata(asset.artifact.extension, asset.artifact.size);
  return { title, body: document.markdown, format: 'text/markdown', assets, cover, options: {
    brief, category: options.category, tags: options.tags, cover: options.cover ?? '', columns: options.columns ?? [],
  } };
}

function uploadStep(artifact: z.infer<typeof artifactSchema>): string { return 'asset.' + artifact.digest + artifact.extension; }
async function createDraft(context: CapabilityContext<JuejinSession>, article: JuejinArticle, uploads: Record<string, string>) {
  const rewritten = await rewriteImages(article.body, scanImages(article.body, '/'), async source => {
    const asset = article.assets.find(asset => localImagePath(asset.source, '/') === source)!;
    return uploads[uploadStep(asset.artifact!)];
  });
  const cover = article.cover?.artifact ? uploads[uploadStep(article.cover.artifact)] : article.options.cover;
  const drafts = new DraftService(context.session.client, context.session.uploader);
  const plan = await drafts.prepareDocument({ content: rewritten.content, metadata: {}, directory: '/' }, {
    title: article.title, brief: article.options.brief, category: article.options.category, tags: article.options.tags, cover,
  });
  const draft = await context.session.client.createDraft(plan.input);
  const remote = { kind: 'draft', id: draft.id, url: 'https://juejin.cn/editor/drafts/' + draft.id };
  await context.remember(remote);
  return remote;
}

const acceptance = { offline: true, liveRead: false, liveWrite: false };
export function createJuejinPlatform(dependencies: { fetch?: typeof globalThis.fetch } = {}) {
  const writeDefinition = workflowCapability<JuejinSession>();
  const handler = stepHandler<JuejinSession>();
  const readDefinition = readCapability<JuejinSession>();
  const writing = (id: string, description: string, publish: boolean) => writeDefinition({
    id, description, acceptance, successStates: publish ? ['submitted', 'published'] : ['draft_saved'], input: articleInputSchema(juejinOptionsSchema), prepared: preparedSchema, output: operationResultSchema,
    prepare: async (raw, context) => prepareArticle(raw, context, 'juejin', juejinOptionsSchema, render),
    preflight: async () => undefined,
    compile: article => {
      const assets = [...article.assets, ...(article.cover ? [article.cover] : [])].filter(asset => asset.artifact);
      const uploads = [...new Map(assets.map(asset => [uploadStep(asset.artifact!), asset.artifact!])).entries()];
      const steps = uploads.map(([id, artifact]) => ({ id, handler: 'asset.upload', version: '1', needs: [], input: artifact }));
      return { id, version: '1', resultStep: publish ? 'article.publish' : 'draft.result', steps: [
        ...steps, { id: 'draft.create', handler: 'draft.create', version: '1', needs: uploads.map(([id]) => id), input: JSON.parse(JSON.stringify(article)) },
        { id: publish ? 'article.publish' : 'draft.result', handler: publish ? 'article.publish' : 'draft.result', version: '1', needs: ['draft.create'], input: { columns: article.options.columns } },
      ] };
    },
    handlers: {
      'asset.upload': handler({ version: '1', effect: 'remote-write', input: artifactSchema, dependencies: z.strictObject({}), output: z.string(),
        execute: async (context, artifact) => {
          try { return await context.session.uploader.upload(context.artifacts.path(artifact)); }
          catch (error) {
            if (error instanceof CliError && error.details?.upload_status === 'committed') await context.remember({ kind: 'image-upload', id: error.details.uri as string });
            throw error;
          }
        },
        recover: async (context, _artifact, _dependencies, saved) => {
          const remote = saved.references.find(reference => reference.kind === 'image-upload');
          if (!remote) return { verdict: 'indeterminate' as const, evidence: { source: 'imagex', message: '缺少已提交的素材 URI，不能判断是否上传完成。' } };
          const url = await context.session.uploader.resolveUrl(remote.id);
          return { verdict: 'effect_confirmed' as const, value: url, evidence: { source: 'imagex.resolve', message: '已解析原素材 URI，没有重复上传。', reference: remote } };
        } }),
      'draft.create': handler({ version: '1', effect: 'remote-write', input: preparedSchema, dependencies: z.record(z.string(), z.string()), output: remoteReferenceSchema, execute: createDraft,
        recover: async (context, _article, _dependencies, saved) => {
          const remote = saved.references.find(reference => reference.kind === 'draft');
          if (!remote) return { verdict: 'indeterminate' as const, evidence: { source: 'draft', message: '缺少本次创建的草稿 ID，不按标题推测。' } };
          await context.session.client.draft(remote.id);
          return { verdict: 'effect_confirmed' as const, value: remote, evidence: { source: 'draft.get', message: '原草稿 ID 可以回读。', reference: remote } };
        } }),
      'article.publish': handler({ version: '1', effect: 'remote-write', input: z.object({ columns: z.array(z.string()) }), dependencies: z.object({ 'draft.create': remoteReferenceSchema }), output: operationResultSchema,
        execute: async (context, input, dependencies) => {
          const result = await context.session.client.publish(dependencies['draft.create'].id, input.columns);
          const remote = { kind: 'article', id: result.article_id, url: 'https://juejin.cn/post/' + result.article_id };
          await context.remember(remote);
          return { status: 'submitted' as const, remote };
        },
        recover: async (_context, _input, _dependencies, saved) => {
          const remote = saved.references.find(reference => reference.kind === 'article');
          if (!remote) return { verdict: 'indeterminate' as const, evidence: { source: 'article', message: '缺少本次发表返回的文章 ID，草稿存在不能证明发表结果。' } };
          return { verdict: 'effect_confirmed' as const, value: { status: 'submitted' as const, remote }, evidence: { source: 'submission_receipt', message: '本步骤已保存服务器返回的文章 ID；当前展示状态另行观察。', reference: remote } };
        } }),
      'draft.result': handler({ version: '1', effect: 'read', input: z.object({ columns: z.array(z.string()) }), dependencies: z.object({ 'draft.create': remoteReferenceSchema }), output: operationResultSchema,
        execute: async (_context, _input, dependencies) => ({ status: 'draft_saved' as const, remote: dependencies['draft.create'] }) }),
    },
    inspect: async ({ session }, remote) => {
      if (remote.kind === 'image-upload') return { state: 'asset_uploaded', remote };
      if (remote.kind === 'draft') { await session.client.draft(remote.id); return { state: 'draft_saved', remote }; }
      await session.client.article(remote.id);
      return { state: 'published', remote };
    },
  });
  return definePlatform({
    id: 'juejin', name: '掘金', driver: { id: 'juejin.web', version: '4' },
    login: async (directory: string) => {
      await ensureBrowser();
      const profile = await login(new SessionStore(directory));
      return { id: profile.user_id, name: profile.user_name };
    },
    withSession: async <T>(account: AccountScope, action: (session: JuejinSession) => Promise<T>) => {
      const cookies = await new SessionStore(account.directory).load();
      const http = new JuejinHttp({ cookie: cookieHeader(cookies), fetch: dependencies.fetch });
      const profile = await http.data<UserProfile>('/user_api/v1/user/get');
      return action({ profile: { id: profile.user_id, name: profile.user_name }, client: new JuejinClient(http), uploader: new ImageUploader(http, dependencies.fetch) });
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
