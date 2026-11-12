import { dirname, resolve, extname } from 'node:path';
import matter from 'gray-matter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { z } from 'zod';
import { parseInput } from '../core/validation.js';
import { inferredTitle, localImagePath, scanImages, rewriteImages } from './markdown.js';
import { CliError } from '../shared/errors.js';
import { artifactSchema, type ContentPreparation } from '../core/content.js';

export interface ArticleDocument {
  file: string; markdown: string; metadata: Record<string, unknown>;
  platforms: Record<string, Record<string, unknown>>;
  preparation: ContentPreparation; captured: Map<string, Asset>;
}
export const assetSchema = z.object({ source: z.string(), artifact: artifactSchema.optional() });
export type Asset = z.infer<typeof assetSchema>;
export const preparedArticleSchema = z.object({
  title: z.string(), body: z.string(), format: z.string(), assets: z.array(assetSchema), cover: assetSchema.optional(),
  options: z.record(z.string(), z.json()),
});
export type PreparedArticle = z.infer<typeof preparedArticleSchema>;
const fileEnvelopeSchema = z.strictObject({ file: z.string().min(1), options: z.unknown().optional() });

export function articleInputSchema<T extends z.ZodRawShape>(options: z.ZodObject<T>) {
  return fileEnvelopeSchema.extend({ options: options.partial().strict().optional() });
}

export async function prepareArticle<T extends z.ZodRawShape, P extends PreparedArticle>(input: { file: string; options?: object }, preparation: ContentPreparation, platformId: string, optionsSchema: z.ZodObject<T>, render: (document: ArticleDocument, options: z.infer<z.ZodObject<T>>) => Promise<P>, defaults: object = {}): Promise<P> {
  const document = await readDocument(input.file, preparation);
  const { platforms: _platforms, ...common } = document.metadata;
  const overrides = input.options;
  // Metadata and explicit options are one input boundary. Only the selected platform's schema owns their fields.
  const shared = Object.fromEntries(Object.entries(common).filter(([key]) => key in optionsSchema.shape));
  const options = parseInput(optionsSchema.strict(), { ...defaults, ...shared, ...document.platforms[platformId], ...overrides });
  // Freeze local references before rendering: neither output nor its digest contains a home or source path.
  const images = scanImages(document.markdown, dirname(document.file));
  document.markdown = (await rewriteImages(document.markdown, images, async path => (await assetFrom(path, document)).source)).content;
  if ('images' in options && Array.isArray(options.images)) Object.assign(options, { images: await Promise.all(options.images.map(async source => (await assetFrom(source, document)).source)) });
  if ('cover' in options && typeof options.cover === 'string') Object.assign(options, { cover: (await assetFrom(options.cover, document)).source });
  const prepared = await render(document, options);
  const extensions: Record<string, string> = { 'text/html': '.html', 'text/markdown': '.md', 'text/plain': '.txt' };
  await preparation.output(Buffer.from(prepared.body), prepared.format, 'body', extensions[prepared.format] ?? '');
  return prepared;
}

export async function readDocument(file: string, preparation: ContentPreparation): Promise<ArticleDocument> {
  const absolute = resolve(file);
  const original = await preparation.capture(absolute, 'text/markdown');
  const source = (await preparation.objects.read(original)).toString('utf8');
  const parsed = matter(source);
  const metadata = parsed.data as Record<string, unknown>;
  const platforms = metadata.platforms ?? {};
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms) || Object.values(platforms).some(value => !value || typeof value !== 'object' || Array.isArray(value))) {
    throw new CliError('INPUT', 'frontmatter.platforms 必须是按平台名称组织的配置对象。');
  }
  preparation.source(original, 'markdown', metadata);
  return { preparation, captured: new Map(), file: absolute, markdown: parsed.content, metadata, platforms: platforms as ArticleDocument['platforms'] };
}

export function documentTitle(document: ArticleDocument, options: { title?: string }): string {
  const title = (options.title ?? inferredTitle(document.markdown) ?? '').trim();
  if (!title) throw new CliError('INPUT', '请提供标题或 Markdown 一级标题。');
  if (!document.markdown.trim()) throw new CliError('INPUT', '文章正文不能为空。');
  return title;
}

export async function assetFrom(source: string, document: ArticleDocument): Promise<Asset> {
  const existing = document.captured.get(source);
  if (existing) return existing;
  const path = localImagePath(source, dirname(document.file));
  if (!path) return { source };
  const mediaTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
  const artifact = await document.preparation.capture(path, mediaTypes[extname(path).toLowerCase()] ?? 'application/octet-stream');
  document.preparation.asset(artifact);
  const asset: Asset = { source: '/wm-assets/' + artifact.digest + artifact.extension, artifact };
  document.captured.set(source, asset);
  document.captured.set(path, asset);
  document.captured.set(asset.source, asset);
  return asset;
}

export function imageSources(markdown: string): string[] {
  const tree = fromMarkdown(markdown);
  const references = new Set<string>();
  const sources: string[] = [];
  const visit = (node: Nodes, action: (node: Nodes) => void) => {
    action(node);
    if ('children' in node) for (const child of node.children) visit(child, action);
  };
  visit(tree, node => { if (node.type === 'imageReference') references.add(node.identifier); });
  visit(tree, node => {
    if (node.type === 'image' || (node.type === 'definition' && references.has(node.identifier))) sources.push(node.url);
  });
  return [...new Set(sources)];
}

export async function documentAssets(document: ArticleDocument, options: { images?: string[] }): Promise<Asset[]> {
  const explicit = options.images ?? [];
  const sources = explicit.length ? explicit : imageSources(document.markdown);
  return Promise.all(sources.map(source => assetFrom(source, document)));
}
