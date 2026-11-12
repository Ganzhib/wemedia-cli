import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import matter from 'gray-matter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import type { ArticleDocument, Asset } from '../core/types.js';
import { inferredTitle, localImagePath } from './markdown.js';
import { CliError } from '../shared/errors.js';

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

export function textOption(options: Record<string, unknown>, name: string, fallback = ''): string {
  const value = options[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new CliError('INPUT', name + ' 必须为字符串。');
  return value;
}

export function listOption(options: Record<string, unknown>, name: string): string[] {
  const value = options[name];
  if (value === undefined) return [];
  if (typeof value === 'string') return value.split(',').map(part => part.trim()).filter(Boolean);
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) return value;
  throw new CliError('INPUT', name + ' 必须为字符串数组或逗号分隔字符串。');
}

export function documentTitle(document: ArticleDocument, options: Record<string, unknown>): string {
  const title = textOption(options, 'title', inferredTitle(document.markdown) ?? '').trim();
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

export async function documentAssets(document: ArticleDocument, options: Record<string, unknown>): Promise<Asset[]> {
  const explicit = listOption(options, 'images');
  const sources = explicit.length ? explicit : imageSources(document.markdown);
  return Promise.all(sources.map(source => assetFrom(source, document)));
}
