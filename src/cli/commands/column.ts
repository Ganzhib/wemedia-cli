import type { Command } from 'commander';
import type { ColumnOptions } from '../../platform/juejin/writing-service.js';
import type { CommandContext } from '../context.js';
import { id, paging, type Paging } from '../options.js';
import { articleSummary } from '../presentation.js';

function columnOptions(command: Command): Command {
  return command.option('--title <title>', '专栏名称（1–50 字）')
    .option('--intro <intro>', '专栏简介（1–150 字）').option('--cover <path-or-url>', '封面图片路径或 URL')
    .option('--dry-run', '验证并展示提交内容，不上传或提交');
}

export function registerColumn(context: CommandContext): void {
  const column = context.program.command('column').description('专栏查询、新建、修改与文章列表');
  paging(column.command('list')).option('--user <id>', '查询指定用户的公开专栏；省略则查询自己的创作者列表', id).action(async (options: Paging & { user?: string }) => {
    const { client } = await context.services(!options.user);
    if (options.user) context.emit(await client.userColumns(options.user, options.cursor, options.limit));
    else context.emit(await client.columns(options.page, options.limit));
  });
  column.command('get <id>').action(async (columnId: string) => context.emit(await (await context.services()).client.column(id(columnId))));
  paging(column.command('articles <id>')).action(async (columnId: string, options: Paging) => {
    const page = await (await context.services()).client.columnArticles(id(columnId), options.cursor, options.limit);
    context.emit({ ...page, items: page.items.map(articleSummary) });
  });
  columnOptions(column.command('create')).action(async (options: ColumnOptions) => {
    context.emit(await (await context.services(!options.dryRun)).writing.saveColumn(options));
  });
  columnOptions(column.command('update <id>')).action(async (columnId: string, options: ColumnOptions) => {
    context.emit(await (await context.services(true)).writing.saveColumn(options, id(columnId)));
  });
}
