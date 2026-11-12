import type { SaveDraftOptions } from '../../platform/juejin/writing-service.js';
import type { CommandContext } from '../context.js';
import { draftOptions, id, paging, type Paging } from '../options.js';

export function registerDraft(context: CommandContext): void {
  const draft = context.program.command('draft').description('草稿管理');
  paging(draft.command('list')).action(async (options: Paging) => context.emit(await (await context.services(true)).client.drafts(options.page, options.limit)));
  draft.command('get <id>').action(async (draftId: string) => context.emit(await (await context.services(true)).client.draft(id(draftId))));
  draftOptions(draft.command('create <file>')).action(async (file: string, options: SaveDraftOptions) => {
    const { writing } = await context.services(!options.dryRun);
    context.emit(await writing.saveDraft(file, options));
  });
  draftOptions(draft.command('update <id> <file>')).action(async (draftId: string, file: string, options: SaveDraftOptions) => {
    const { writing } = await context.services(true);
    context.emit(await writing.saveDraft(file, options, id(draftId)));
  });
}
