import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import matter from 'gray-matter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import type { Definition, Image, Nodes } from 'mdast';
import { CliError } from '../shared/errors.js';

export interface ArticleMetadata { title?: string; brief?: string; category?: string; tags?: string[]; cover?: string }
export interface MarkdownDocument { content: string; metadata: ArticleMetadata; directory: string }
export interface LocalImage { path: string; url: string; node: Image | Definition }

export function omitRepeatedTitle(content: string, title: string): string {
  const first = fromMarkdown(content).children[0];
  if (first?.type !== 'heading' || first.depth !== 1) return content;
  let label = '';
  visit(first, node => { if (node.type === 'text' || node.type === 'inlineCode') label += node.value; });
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');
  if (normalize(label) !== normalize(title)) return content;
  return content.slice(first.position!.end.offset!).replace(/^\s*\r?\n/, '');
}

function visit(node: Nodes, callback: (node: Nodes) => void): void {
  callback(node);
  if ('children' in node) for (const child of node.children) visit(child, callback);
}

export async function readArticle(file: string): Promise<MarkdownDocument> {
  const source = await readFile(file, 'utf8');
  const parsed = matter(source);
  const raw = parsed.data;
  for (const key of ['title', 'brief', 'category', 'cover']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new CliError('INPUT', `frontmatter.${key} 必须为字符串。`);
  }
  let tags: string[] | undefined;
  if (typeof raw.tags === 'string') tags = raw.tags.split(',').map(tag => tag.trim()).filter(Boolean);
  else if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.some(tag => typeof tag !== 'string')) throw new CliError('INPUT', 'frontmatter.tags 必须为字符串数组或逗号分隔字符串。');
    tags = raw.tags;
  }
  return {
    content: parsed.content, directory: dirname(resolve(file)),
    metadata: { title: raw.title, brief: raw.brief, category: raw.category, tags, cover: raw.cover },
  };
}

export function localImagePath(url: string, directory: string): string | undefined {
  if (/^https?:\/\//i.test(url) || url.startsWith('//')) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^[a-z]:[\\/]/i.test(url)) throw new CliError('INPUT', `图片仅支持本地路径或 HTTP(S) URL：${url}`);
  let decoded: string;
  try { decoded = decodeURIComponent(url); }
  catch { throw new CliError('INPUT', `图片路径含非法 URL 编码：${url}`); }
  return resolve(directory, decoded);
}

export function scanImages(content: string, directory: string): LocalImage[] {
  const tree = fromMarkdown(content);
  const referenced = new Set<string>();
  visit(tree, node => { if (node.type === 'imageReference') referenced.add(node.identifier); });
  const images: LocalImage[] = [];
  visit(tree, node => {
    if (node.type !== 'image' && !(node.type === 'definition' && referenced.has(node.identifier))) return;
    const path = localImagePath(node.url, directory);
    if (path) images.push({ path, url: node.url, node });
  });
  return images;
}

export async function rewriteImages(
  content: string,
  images: LocalImage[],
  upload: (path: string) => Promise<string>,
): Promise<{ content: string; uploads: Map<string, string> }> {
  const uploads = new Map<string, string>();
  for (const image of images) {
    if (!uploads.has(image.path)) uploads.set(image.path, await upload(image.path));
  }
  let rewritten = content;
  // Source offsets preserve prose, fenced code examples, and unrelated links verbatim.
  for (const image of [...images].sort((left, right) => right.node.position!.start.offset! - left.node.position!.start.offset!)) {
    const replacement = toMarkdown({ ...image.node, url: uploads.get(image.path)! }).trimEnd();
    const position = image.node.position!;
    rewritten = rewritten.slice(0, position.start.offset!) + replacement + rewritten.slice(position.end.offset!);
  }
  return { content: rewritten, uploads };
}

export function inferredTitle(content: string): string | undefined {
  const heading = fromMarkdown(content).children.find(node => node.type === 'heading' && node.depth === 1);
  if (!heading) return undefined;
  const pieces: string[] = [];
  visit(heading, node => { if (node.type === 'text' || node.type === 'inlineCode') pieces.push(node.value); });
  return pieces.join('');
}
