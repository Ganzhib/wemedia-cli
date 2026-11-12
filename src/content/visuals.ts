import { z } from 'zod';
import type { Page } from 'playwright';
import { parseInput } from '../core/validation.js';
import { CliError } from '../shared/errors.js';

export const captureSchema = z.object({
  url: z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), '仅支持 HTTP(S) 网页'),
  width: z.coerce.number().int().min(320).max(2560).default(1440),
  height: z.coerce.number().int().min(240).max(2560).default(1000),
  fullPage: z.boolean().default(false), selector: z.string().min(1).optional(),
});
export async function captureWebsite(page: Page, input: unknown) {
  const options = parseInput(captureSchema, input);
  await page.setViewportSize({ width: options.width, height: options.height });
  const response = await page.goto(options.url, { waitUntil: 'networkidle', timeout: 45_000 });
  if (!response?.ok()) throw new CliError('NETWORK', '网页未返回成功响应。', { status: response?.status() });
  await page.evaluate(() => document.fonts.ready);
  const target = options.selector ? page.locator(options.selector) : undefined;
  if (target && await target.count() !== 1) throw new CliError('INPUT', '截图选择器必须匹配一个元素。');
  return target ? target.screenshot({ type: 'png', animations: 'disabled', timeout: 15_000 })
    : page.screenshot({ type: 'png', fullPage: options.fullPage, animations: 'disabled', timeout: 15_000 });
}

const nodeSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]*$/), title: z.string().min(1).max(50),
  lines: z.array(z.string().max(70)).max(3).default([]),
  x: z.number().int().min(0), y: z.number().int().min(100),
  width: z.number().int().min(180).max(1200).default(300), height: z.number().int().min(100).max(300).default(120),
  tone: z.enum(['green', 'blue', 'sand']).default('green'),
});
export const diagramSchema = z.strictObject({
  title: z.string().min(1).max(80), subtitle: z.string().max(120).default(''),
  width: z.number().int().min(600).max(2400).default(1400), height: z.number().int().min(400).max(2400).default(1200),
  nodes: z.array(nodeSchema).min(1).max(30),
  edges: z.array(z.strictObject({ from: z.string(), to: z.string(), label: z.string().max(40).default('') })).max(60).default([]),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.nodes.forEach((node, i) => {
    if (ids.has(node.id)) ctx.addIssue({ code: 'custom', message: '节点 ID 重复', path: ['nodes', i, 'id'] });
    ids.add(node.id);
    if (node.x + node.width > value.width || node.y + node.height > value.height) ctx.addIssue({ code: 'custom', message: '节点超出画布', path: ['nodes', i] });
  });
  value.edges.forEach((edge, i) => {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) ctx.addIssue({ code: 'custom', message: '连线端点无效', path: ['edges', i] });
  });
});
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function diagramSvg(input: unknown) {
  const spec = parseInput(diagramSchema, input);
  const palette = { green: '#e2eee5', blue: '#e5edf5', sand: '#f5ecdb' };
  const lines = spec.edges.map(edge => {
    const from = spec.nodes.find(node => node.id === edge.from)!; const to = spec.nodes.find(node => node.id === edge.to)!;
    const horizontal = Math.abs(from.y - to.y) < Math.min(from.height, to.height);
    const right = to.x > from.x;
    const x1 = horizontal ? from.x + (right ? from.width : 0) : from.x + from.width / 2;
    const y1 = horizontal ? from.y + from.height / 2 : from.y + (to.y > from.y ? from.height : 0);
    const x2 = horizontal ? to.x + (right ? 0 : to.width) : to.x + to.width / 2;
    const y2 = horizontal ? to.y + to.height / 2 : to.y + (to.y > from.y ? 0 : to.height);
    const d = horizontal ? `M${x1},${y1} H${(x1 + x2) / 2} V${y2} H${x2}` : `M${x1},${y1} V${(y1 + y2) / 2} H${x2} V${y2}`;
    return `<path d="${d}" fill="none" stroke="#597365" stroke-width="3" marker-end="url(#arrow)"/><text x="${(x1 + x2) / 2 + 8}" y="${(y1 + y2) / 2 - 9}" font-size="17" fill="#496253">${escape(edge.label)}</text>`;
  }).join('');
  const nodes = spec.nodes.map(node => `<g><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="12" fill="${palette[node.tone]}" stroke="#91aa9b"/><text x="${node.x + 20}" y="${node.y + 34}" font-size="23" font-weight="700">${escape(node.title)}</text>${node.lines.map((line, i) => `<text x="${node.x + 20}" y="${node.y + 64 + 25 * i}" font-size="18" fill="#485e52">${escape(line)}</text>`).join('')}</g>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#597365"/></marker></defs><rect width="100%" height="100%" fill="#fafbf6"/><g font-family="Microsoft YaHei,PingFang SC,sans-serif" fill="#203d2d"><text x="36" y="45" font-size="30" font-weight="700">${escape(spec.title)}</text><text x="36" y="78" font-size="18" fill="#52695c">${escape(spec.subtitle)}</text>${lines}${nodes}</g></svg>`;
}
export async function renderDiagram(page: Page, input: unknown) {
  const svg = diagramSvg(input);
  await page.route('**/*', route => route.abort());
  await page.setContent(svg);
  await page.evaluate(() => document.fonts.ready);
  return page.locator('svg').screenshot({ type: 'png', animations: 'disabled' });
}
