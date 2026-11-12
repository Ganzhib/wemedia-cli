import { remoteReferenceSchema, operationResultSchema, resourceSnapshotSchema } from '../../core/types.js';
import { z } from 'zod';
import { definePlatform } from '../../core/platform.js';
import { readCapability, workflowCapability } from '../../core/capability.js';
import { listInputSchema, resourceListSchema } from '../../core/schemas.js';
import type { AccountScope, CapabilityContext } from '../../core/types.js';
import { assetFrom, documentAssets, documentTitle, articleInputSchema, prepareArticle, preparedArticleSchema, type ArticleDocument } from '../../content/document.js';
import { artifactSchema } from '../../core/content.js';
import { stepHandler } from '../../core/workflow.js';
import { rewriteImages, scanImages, localImagePath, omitRepeatedTitle } from '../../content/markdown.js';
import { resourceSnapshot, resourceBaseline } from '../../content/resources.js';
import { requireDraftVersion as requireVersion, sameDraftContent } from './resource-version.js';
import type { DraftInput } from './types.js';
import { CliError } from '../../shared/errors.js';
import { JuejinClient } from './client.js';
import { JuejinHttp } from './http.js';
import { ImageUploader, validateImageMetadata } from './imagex.js';
import { SessionStore, cookieHeader, login, type UserProfile } from './session.js';
import { ensureBrowser } from '../../runtime/managed-browser.js';

export const juejinOptionsSchema = z.object({
  title: z.string().optional(), brief: z.string().min(50).max(100).optional(), summary: z.string().min(50).max(100).optional(),
  category: z.string().regex(/^\d+$/), tags: z.array(z.string().regex(/^\d+$/)).min(1), columns: z.array(z.string()).optional(),
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
    brief, category: options.category, tags: [...new Set(options.tags)].sort(), cover: options.cover ?? '', columns: [...new Set(options.columns ?? [])].sort(),
  } };
}

function uploadStep(artifact: z.infer<typeof artifactSchema>): string { return 'asset.' + artifact.digest + artifact.extension; }
async function draftInput(article: JuejinArticle, uploads: Record<string, string>): Promise<DraftInput> {
  const rewritten = await rewriteImages(article.body, scanImages(article.body, '/'), async source => {
    const asset = article.assets.find(asset => localImagePath(asset.source, '/') === source)!;
    return uploads[uploadStep(asset.artifact!)];
  });
  const cover = article.cover?.artifact ? uploads[uploadStep(article.cover.artifact)] : article.options.cover;
  return { title: article.title, mark_content: omitRepeatedTitle(rewritten.content, article.title),
    brief_content: article.options.brief, category_id: article.options.category, tag_ids: article.options.tags, cover_image: cover };
}
async function createDraft(context: CapabilityContext<JuejinSession>, article: JuejinArticle, uploads: Record<string, string>) {
  const draft = await context.session.client.createDraft(await draftInput(article, uploads));
  const remote = { kind: 'draft', id: draft.id, url: 'https://juejin.cn/editor/drafts/' + draft.id };
  await context.remember(remote);
  return remote;
}

const draftDataSchema = z.object({ title: z.string(), body: z.string(), brief: z.string(), category: z.string(), tags: z.array(z.string()), cover: z.string() });
const draftBaseSchema = resourceSnapshotSchema.extend({ resource: remoteReferenceSchema.extend({ kind: z.literal('draft') }), data: draftDataSchema });
const draftBaselineSchema = draftBaseSchema.omit({ observedAt: true });
const updatePreparedSchema = preparedSchema.extend({ base: draftBaselineSchema });
const imageReceiptSchema = z.object({ uri: z.string(), url: z.string() });
function draftData(draft: DraftInput) { return { title: draft.title, body: draft.mark_content, brief: draft.brief_content, category: draft.category_id, tags: [...draft.tag_ids].sort(), cover: draft.cover_image }; }
async function readDraft(client: JuejinClient, remote: z.infer<typeof remoteReferenceSchema>) {
  const draft = await client.draft(remote.id);
  return resourceSnapshot({ ...remote, kind: 'draft' as const }, 'draft', draftData(draft));
}
async function cachedImage(context: CapabilityContext<JuejinSession>, artifact: z.infer<typeof artifactSchema>, allocate: () => Promise<z.infer<typeof imageReceiptSchema>>) {
  let uploadStarted = false;
  try {
    return await context.uploads.use(artifact, 'article-image', 'imagex-v1', imageReceiptSchema, {
      upload: async () => { uploadStarted = true; return { value: await allocate() }; },
      revalidate: async saved => ({ value: { uri: saved.uri, url: await context.session.uploader.resolveUrl(saved.uri) } }),
    });
  } catch (error) {
    // This helper owns one atomic upload step; cache reads have no preceding write here.
    if (!uploadStarted && error instanceof CliError) throw new CliError(error.code, error.message, { ...error.details, outcome: 'rejected' });
    throw error;
  }
}

const acceptance = { offline: true, liveRead: false, liveWrite: false };
export function createJuejinPlatform(dependencies: { fetch?: typeof globalThis.fetch } = {}) {
  const writeDefinition = workflowCapability<JuejinSession>();
  const handler = stepHandler<JuejinSession>();
  const readDefinition = readCapability<JuejinSession>();
  const handlers = {
      'asset.upload': handler({ version: '1', effect: 'remote-write', input: artifactSchema, dependencies: z.record(z.string(), z.string()), output: z.string(),
        execute: async (context, artifact) => {
          try { return (await cachedImage(context, artifact, () => context.session.uploader.upload(context.artifacts.path(artifact)))).url; }
          catch (error) {
            if (error instanceof CliError && error.details?.upload_status === 'committed') await context.remember({ kind: 'image-upload', id: error.details.uri as string }, 'asset');
            throw error;
          }
        },
        recover: async (context, artifact, _dependencies, saved) => {
          const remote = saved.references.find(reference => reference.kind === 'image-upload');
          if (!remote) return { verdict: 'indeterminate' as const, evidence: { source: 'imagex', message: '缺少已提交的素材 URI，不能判断是否上传完成。' } };
          const { url } = await cachedImage(context, artifact, async () => ({ uri: remote.id, url: await context.session.uploader.resolveUrl(remote.id) }));
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
      'draft.existing': handler({ version: '1', effect: 'read', input: draftBaselineSchema, dependencies: z.strictObject({}), output: remoteReferenceSchema,
        execute: async (context, base) => { requireVersion(base, await readDraft(context.session.client, base.resource)); await context.remember(base.resource); return base.resource; } }),
      'draft.guard': handler({ version: '1', effect: 'read', input: draftBaselineSchema, dependencies: z.strictObject({}), output: z.string(),
        execute: async (context, base) => { const current = await readDraft(context.session.client, base.resource); requireVersion(base, current); await context.remember(base.resource); return current.version; } }),
      'draft.update': handler({ version: '1', effect: 'remote-write', input: updatePreparedSchema, dependencies: z.record(z.string(), z.string()), output: z.string(),
        execute: async (context, article, uploads) => {
          requireVersion(article.base, await readDraft(context.session.client, article.base.resource));
          await context.session.client.updateDraft(article.base.resource.id, await draftInput(article, uploads));
          await context.remember(article.base.resource); return article.base.resource.id;
        },
        recover: async (context, article, uploads) => {
          const current = await readDraft(context.session.client, article.base.resource); const expected = await draftInput(article, uploads);
          if (!sameDraftContent(current.data, draftData(expected))) return { verdict: 'indeterminate' as const, evidence: { source: 'draft.get', message: '原草稿内容没有确认本次更新。', reference: article.base.resource } };
          return { verdict: 'effect_confirmed' as const, value: article.base.resource.id, evidence: { source: 'draft.get', message: '原草稿回读匹配本次更新内容。', reference: article.base.resource } };
        } }),
      'draft.verify': handler({ version: '1', effect: 'read', input: updatePreparedSchema, dependencies: z.record(z.string(), z.string()), output: operationResultSchema,
        execute: async (context, article, uploads) => {
          const current = await readDraft(context.session.client, article.base.resource); const expected = await draftInput(article, uploads);
          if (!sameDraftContent(current.data, draftData(expected))) throw new CliError('UNKNOWN', '保存已获响应，回读尚未匹配；不会重复更新。');
          return { status: 'draft_saved' as const, remote: article.base.resource, observation: { state: 'draft', remote: article.base.resource, snapshot: current } };
        } }),
      'draft.result': handler({ version: '1', effect: 'read', input: z.object({ columns: z.array(z.string()) }), dependencies: z.object({ 'draft.create': remoteReferenceSchema }), output: operationResultSchema,
        execute: async (_context, _input, dependencies) => ({ status: 'draft_saved' as const, remote: dependencies['draft.create'] }) }),
    };
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
    handlers,

    inspect: async ({ session }, remote) => {
      if (remote.kind === 'draft') { await session.client.draft(remote.id); return { state: 'draft_saved', remote }; }
      await session.client.article(remote.id);
      return { state: 'published', remote };
    },
  });
  return definePlatform({
    id: 'juejin', name: '掘金', driver: { id: 'juejin.web', version: '5' },
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
      readDefinition({ id: 'resource.get', description: '读取已有草稿版本或文章的当前内容', acceptance, input: z.strictObject({ resource: remoteReferenceSchema.extend({ kind: z.enum(['draft', 'article']) }) }), output: resourceSnapshotSchema,
        execute: async ({ session }, input) => {
          if (input.resource.kind === 'draft') return readDraft(session.client, input.resource);
          const article = (await session.client.article(input.resource.id)).article_info;
          return resourceSnapshot(input.resource, 'available', { title: article.title, body: article.mark_content, brief: article.brief_content });
        } }),
      writeDefinition({ id: 'draft.update', description: '核对远端版本后更新同一草稿并回读', acceptance, successStates: ['draft_saved'],
        input: articleInputSchema(juejinOptionsSchema).extend({ base: draftBaseSchema }), prepared: updatePreparedSchema, output: operationResultSchema,
        prepare: async (raw, context) => ({ ...(await prepareArticle(raw, context, 'juejin', juejinOptionsSchema, render, { brief: raw.base.data.brief, category: raw.base.data.category, tags: raw.base.data.tags, cover: raw.base.data.cover })), base: resourceBaseline(raw.base) }),
        preflight: async () => undefined, handlers,
        compile: article => {
          const artifacts = [...article.assets, ...(article.cover ? [article.cover] : [])].filter(asset => asset.artifact).map(asset => asset.artifact!);
          const unique = [...new Map(artifacts.map(artifact => [uploadStep(artifact), artifact])).entries()];
          const needs = ['draft.guard', ...unique.map(([id]) => id)];
          return { id: 'draft.update', version: '1', resultStep: 'draft.verify', steps: [
            { id: 'draft.guard', handler: 'draft.guard', version: '1', needs: [], input: article.base },
            ...unique.map(([id, artifact]) => ({ id, handler: 'asset.upload', version: '1', needs: ['draft.guard'], input: artifact })),
            { id: 'draft.update', handler: 'draft.update', version: '1', needs, input: JSON.parse(JSON.stringify(article)) },
            { id: 'draft.verify', handler: 'draft.verify', version: '1', needs: [...needs, 'draft.update'], input: JSON.parse(JSON.stringify(article)) },
          ] };
        },
      }),
      writeDefinition({ id: 'draft.publish', description: '核对已有草稿版本后从原资源提交到专栏', acceptance, successStates: ['submitted', 'published'],
        input: z.strictObject({ base: draftBaseSchema, columns: z.array(z.string()).default([]) }), prepared: z.object({ base: draftBaselineSchema, columns: z.array(z.string()) }), output: operationResultSchema,
        prepare: async input => ({ base: resourceBaseline(input.base), columns: input.columns }), preflight: async () => undefined, handlers,
        compile: input => ({ id: 'draft.publish', version: '1', resultStep: 'article.publish', steps: [
          { id: 'draft.create', handler: 'draft.existing', version: '1', needs: [], input: input.base },
          { id: 'article.publish', handler: 'article.publish', version: '1', needs: ['draft.create'], input: { columns: [...new Set(input.columns)].sort() } },
        ] }),
      }),
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
