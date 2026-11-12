import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import type { Nodes } from 'mdast';
import type { ResourceSnapshot } from '../../core/types.js';
import { requireVersion } from '../../content/resources.js';
import { semanticDigest } from '../../runtime/objects.js';

function imageIdentity(source: string): string {
  let url: URL;
  try { url = new URL(source); } catch { return source; }
  if (url.protocol !== 'https:' || !/^p\d+-xtjj-private\.juejin\.cn$/.test(url.hostname)) return source;
  // These fields are refreshed on reads; retain the image path, transform and other parameters.
  for (const key of ['rk3s', 'x-orig-authkey', 'x-orig-expires', 'x-orig-sign']) url.searchParams.delete(key);
  return url.href;
}

function imageIdentities(markdown: string): string {
  const tree = fromMarkdown(markdown);
  const nodes: Nodes[] = [];
  const visit = (node: Nodes): void => { nodes.push(node); if ('children' in node) node.children.forEach(visit); };
  visit(tree);
  const referenced = new Set(nodes.flatMap(node => node.type === 'imageReference' ? [node.identifier] : []));
  let result = markdown;
  for (const node of nodes.reverse()) {
    if (node.type !== 'image' && !(node.type === 'definition' && referenced.has(node.identifier))) continue;
    const start = node.position!.start.offset!; const end = node.position!.end.offset!;
    const url = imageIdentity(node.url);
    if (url === node.url) continue;
    result = result.slice(0, start) + toMarkdown({ ...node, url }).trimEnd() + result.slice(end);
  }
  return result;
}

function comparable(data: ResourceSnapshot['data']): ResourceSnapshot['data'] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  return { ...data, ...(typeof data.body === 'string' ? { body: imageIdentities(data.body) } : {}),
    ...(typeof data.cover === 'string' ? { cover: imageIdentity(data.cover) } : {}) };
}

export function sameDraftContent(before: ResourceSnapshot['data'], after: ResourceSnapshot['data']): boolean {
  return semanticDigest(comparable(before)) === semanticDigest(comparable(after));
}

export function requireDraftVersion(expected: Pick<ResourceSnapshot, 'resource' | 'version' | 'data'>, current: ResourceSnapshot): void {
  requireVersion(expected, current, sameDraftContent);
}
