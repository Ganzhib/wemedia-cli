import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { captureSchema, captureWebsite, diagramSchema, renderDiagram } from '../../content/visuals.js';
import { saveLocalArtifact } from '../../runtime/local-artifacts.js';
import { withMediaPage } from '../../runtime/media-browser.js';
import { parseInput } from '../../core/validation.js';
import { CliError } from '../../shared/errors.js';
import type { CommandContext } from '../context.js';

async function source(file: string) {
  if (file !== '-') return readFile(file);
  const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
export function registerContent({ program, emit }: CommandContext) {
  const content = program.command('content').description('准备本地文章、官网截图与架构图，不连接平台账号');
  content.command('write <file>').description('从输入保存本地内容；不覆盖已有文件').requiredOption('--input <file>', '输入文件，- 表示 stdin')
    .action(async (file: string, flags: { input: string }) => emit(await saveLocalArtifact(file, await source(flags.input))));
  content.command('screenshot <url>').description('用独立无登录会话截取公开网页为 PNG').requiredOption('--output <file>', '输出 PNG 文件')
    .option('--width <pixels>', '视口宽度', '1440').option('--height <pixels>', '视口高度', '1000')
    .option('--full-page', '截取完整页面').option('--selector <css>', '只截取唯一匹配的页面元素')
    .action(async (url: string, flags: { output: string; width: string; height: string; fullPage?: boolean; selector?: string }) => {
      const input = parseInput(captureSchema, { url, width: flags.width, height: flags.height, fullPage: flags.fullPage ?? false, selector: flags.selector });
      const bytes = await withMediaPage(page => captureWebsite(page, input));
      emit({ ...await saveLocalArtifact(flags.output, bytes), source: url, kind: 'website-screenshot' });
    });
  content.command('diagram <file>').description('按 JSON 节点和连线绘制架构图 PNG，- 表示 stdin').requiredOption('--output <file>', '输出 PNG 文件')
    .action(async (file: string, flags: { output: string }) => {
      let input: unknown;
      try { input = JSON.parse((await source(file)).toString('utf8')); } catch { throw new CliError('INPUT', '图定义必须是有效 JSON。'); }
      const spec = parseInput(diagramSchema, input);
      const bytes = await withMediaPage(page => renderDiagram(page, spec));
      emit({ ...await saveLocalArtifact(flags.output, bytes), kind: 'architecture-diagram' });
    });
  content.command('diagram-schema').description('输出图定义的 JSON Schema').action(() => emit(z.toJSONSchema(diagramSchema)));
}
