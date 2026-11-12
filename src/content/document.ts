import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import matter from 'gray-matter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { z } from 'zod';
import { parseInput } from '../core/capability.js';
import { inferredTitle, localImagePath } from './markdown.js';
import { CliError } from '../shared/errors.js';

export interface ArticleDocument {
  file: string; sourceDigest: string; markdown: string; metadata: Record<string, unknown>;
  platforms: Record<string, Record<string, unknown>>;
}
export const assetSchema = z.object({ source: z.string(), path: z.string().optional(), digest: z.string().optional(), size: z.number().optional() });
export type Asset = z.infer<typeof assetSchema>;
export const preparedArticleSchema = z.object({
  title: z.string(), body: z.string(), format: z.string(), assets: z.array(assetSchema), cover: assetSchema.optional(),
  options: z.record(z.string(), z.json()), source: z.object({ file: z.string(), digest: z.string() }).optional(),
});
export type PreparedArticle = z.infer<typeof preparedArticleSchema>;
const fileEnvelopeSchema = z.strictObject({ file: z.string().min(1), options: z.unknown().optional() });

export function articleInputSchema<T extends z.ZodRawShape>(options: z.ZodObject<T>) {
  return fileEnvelopeSchema.extend({ options: options.partial().strict().optional() });
}

export async function prepareArticle<T extends z.ZodRawShape, P extends PreparedArticle>(input: { file: string; options?: object }, platformId: string, optionsSchema: z.ZodObject<T>, render: (document: ArticleDocument, options: z.infer<z.ZodObject<T>>) => Promise<P>): Promise<P> {
  const document = await readDocument(input.file);
  const { platforms: _platforms, ...common } = document.metadata;
  const overrides = input.options;
  // Metadata and explicit options are one input boundary. Only the selected platform's schema owns their fields.
  const shared = Object.fromEntries(Object.entries(common).filter(([key]) => key in optionsSchema.shape));
  const options = parseInput(optionsSchema.strict(), { ...shared, ...document.platforms[platformId], ...overrides });
  const article = await render(document, options);
  return { ...article, source: { file: document.file, digest: document.sourceDigest } };
}

export async function preflightArticle(article: PreparedArticle): Promise<void> {
  if (article.source && digest(await readFile(article.source.file)) !== article.source.digest) throw new CliError('INPUT', '源文件已改变，请重新准备内容。');
  for (const asset of [...article.assets, ...(article.cover ? [article.cover] : [])]) {
    if (asset.path && digest(await readFile(asset.path)) !== asset.digest) throw new CliError('INPUT', '图片已改变，请重新准备内容：' + asset.path);
  }
}

export function digest(content: string | Uint8Array): string { return createHash('sha256').update(content).digest('hex'); }

export async function readDocument(file: string): Promise<ArticleDocument> {
  const absolute = resolve(file);
  const source = await readFile(absolute, 'utf8');
  const parsed = matter(source);
  const metadata = parsed.data as Record<string, unknown>;
  const platforms = metadata.platforms ?? {};
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms) || Object.values(platforms).some(value => !value || typeof value !== 'object' || Array.isArray(value))) {
    throw new CliError('INPUT', 'frontmatter.platforms 必须是按平台名称组织的配置对象。');
  }
  return { file: absolute, sourceDigest: digest(source), markdown: parsed.content, metadata, platforms: platforms as ArticleDocument['platforms'] };
}

export function documentTitle(document: ArticleDocument, options: { title?: string }): string {
  const title = (options.title ?? inferredTitle(document.markdown) ?? '').trim();
  if (!title) throw new CliError('INPUT', '请提供标题或 Markdown 一级标题。');
  if (!document.markdown.trim()) throw new CliError('INPUT', '文章正文不能为空。');
  return title;
}

export async function assetFrom(source: string, document: ArticleDocument): Promise<Asset> {
  const path = localImagePath(source, dirname(document.file));
  if (!path) return { source };
  const bytes = await readFile(path);
  return { source, path, size: bytes.length, digest: digest(bytes) };
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
