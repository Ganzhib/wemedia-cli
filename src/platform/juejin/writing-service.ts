import { JuejinClient } from './client.js';
import { ImageUploader, validateImage } from './imagex.js';
import { SessionStore } from './session.js';
import { OperationJournal } from '../../runtime/journal.js';
import { localImagePath } from '../../content/markdown.js';
import { CliError } from '../../shared/errors.js';
import { DraftService, type DraftOptions } from './draft-service.js';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { checkInDate, supplementTimestamp } from './checkin-date.js';
import { validatePublishContent } from '../../content/publish-check.js';

export interface SaveDraftOptions extends DraftOptions { dryRun?: boolean }
export interface ColumnOptions { title?: string; intro?: string; cover?: string; dryRun?: boolean }
export interface PublishOptions { draft: string; columns?: string[]; dryRun?: boolean }

export class WritingService {
  constructor(
    private readonly client: JuejinClient,
    private readonly uploader: ImageUploader,
    private readonly session: SessionStore,
    private readonly drafts: DraftService,
  ) {}

  async publishDirectory(directory: string, options: SaveDraftOptions & { column: string }) {
    const root = resolve(directory);
    const entries = await readdir(root, { withFileTypes: true });
    const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => join(root, entry.name)).sort();
    if (!files.length) throw new CliError('INPUT', '目录中没有 Markdown 文件。');
    const fingerprint = createHash('sha256');
    fingerprint.update(JSON.stringify({ ...options, dryRun: undefined }));
    for (const file of files) { fingerprint.update(file); fingerprint.update(await readFile(file)); }
    const digest = fingerprint.digest('hex');
    const checkpoint = join(root, '.juejin-batch.json');
    const lock = join(root, '.juejin-batch.lock');
    try { await mkdir(lock); } catch { throw new CliError('BUSY', '此目录已有批量任务；请等待任务结束。'); }
    type Item = { file: string; phase: 'creating' | 'draft' | 'publishing' | 'done'; draft_id?: string; article_id?: string };
    let state: { digest: string; items: Item[] } = { digest, items: [] };
    const save = async () => { await writeFile(checkpoint + '.tmp', JSON.stringify(state, null, 2)); await rename(checkpoint + '.tmp', checkpoint); };
    try {
      try { state = JSON.parse(await readFile(checkpoint, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CliError('INPUT', '批量进度文件无法读取，请先核对已有操作回执。'); }
      if (!state || typeof state !== 'object' || state.digest !== digest || !Array.isArray(state.items)) throw new CliError('INPUT', '文章或配置与已有批量任务不同，请使用新目录并先核对旧任务结果。');
      if (state.items.some(item => !item || !files.includes(item.file) || !['creating', 'draft', 'publishing', 'done'].includes(item.phase) || (item.draft_id !== undefined && !/^\d+$/.test(item.draft_id)) || (item.phase === 'done' && !/^\d+$/.test(item.article_id ?? ''))) || new Set(state.items.map(item => item.file)).size !== state.items.length) throw new CliError('INPUT', '批量进度文件格式不正确，请核对操作回执。');
      if (state.items.some(item => item.phase === 'creating' || item.phase === 'publishing')) throw new CliError('INPUT', '上次写入结果尚未确认，请先用 history 核对；不会自动重放写入。', { checkpoint });
      const pending = files.filter(file => !state.items.some(item => item.file === file && item.phase === 'done'));
      // Validate every remaining article before the first remote write.
      const plans = [];
      for (const file of pending) {
        const plan = await this.drafts.prepare(file, options);
        validatePublishContent(plan.input.title, plan.input.mark_content);
        plans.push(plan);
      }
      if (options.dryRun) return { dry_run: true, column_id: options.column, count: pending.length, articles: plans.map((plan, index) => ({ file: pending[index], title: plan.input.title, category_id: plan.input.category_id, tag_ids: plan.input.tag_ids })) };
      for (const file of pending) {
        let item = state.items.find(item => item.file === file);
        if (!item) {
          item = { file, phase: 'creating' }; state.items.push(item); await save();
          const draft = await this.saveDraft(file, options);
          if (!('draft_id' in draft)) throw new CliError('INTERNAL', '草稿未返回 ID。');
          item.draft_id = draft.draft_id; item.phase = 'draft'; await save();
        }
        if (!item.draft_id) throw new CliError('INPUT', '批量进度缺少草稿 ID，请核对回执。');
        item.phase = 'publishing'; await save();
        const article = await this.publish({ draft: item.draft_id, columns: [options.column] });
        if (!('article_id' in article)) throw new CliError('INTERNAL', '发布未返回文章 ID。');
        item.article_id = article.article_id; item.phase = 'done'; await save();
      }
      return { status: 'submitted', submitted_count: pending.length, skipped_count: files.length - pending.length, column_id: options.column, checkpoint, articles: state.items };
    } finally { await rm(lock, { recursive: true }); }
  }

  async saveDraft(file: string, options: SaveDraftOptions, draftId?: string) {
    if (options.dryRun) {
      const existing = draftId ? await this.client.draft(draftId) : undefined;
      return { ...await this.drafts.prepare(file, options, existing), dry_run: true };
    }
    return this.session.withWriteLock(async () => {
      const existing = draftId ? await this.client.draft(draftId) : undefined;
      const plan = await this.drafts.prepare(file, options, existing);
      const input = await this.drafts.uploadAssets(plan);
      const operation = draftId ? 'draft.update' : 'draft.create';
      return new OperationJournal(this.session.home).run(operation, { draft_id: draftId }, async () => {
        let savedId: string;
        if (draftId) { await this.client.updateDraft(draftId, input); savedId = draftId; }
        else savedId = (await this.client.createDraft(input)).id;
        return { draft_id: savedId, preview_url: `https://juejin.cn/editor/drafts/${savedId}` };
      });
    });
  }

  private async prepareColumn(options: ColumnOptions, columnId?: string) {
    const existing = columnId ? await this.client.column(columnId) : undefined;
    const title = options.title ?? existing?.column_version.title ?? '';
    const content = options.intro ?? existing?.column_version.content ?? '';
    const cover = options.cover ?? existing?.column_version.cover ?? '';
    if (!title.trim() || title.length > 50) throw new CliError('INPUT', '专栏名称必须为 1–50 字。');
    if (!content.trim() || content.length > 150) throw new CliError('INPUT', '专栏简介必须为 1–150 字。');
    const localCover = cover ? localImagePath(cover, process.cwd()) : undefined;
    if (localCover) await validateImage(localCover);
    return { title, content, cover, localCover };
  }

  async saveColumn(options: ColumnOptions, columnId?: string) {
    if (options.dryRun) return { column_id: columnId ?? '0', ...await this.prepareColumn(options, columnId), dry_run: true };
    return this.session.withWriteLock(async () => {
      // Read and merge editable fields under the same lock as the write.
      const { title, content, cover, localCover } = await this.prepareColumn(options, columnId);
      const input = { title, content, cover: localCover ? await this.uploader.upload(localCover) : cover };
      return new OperationJournal(this.session.home).run(columnId ? 'column.update' : 'column.create', { column_id: columnId }, async () => {
        let savedId: string;
        if (columnId) { await this.client.updateColumn(columnId, input); savedId = columnId; }
        else savedId = await this.client.createColumn(input);
        return { column_id: savedId, status: 'submitted', url: `https://juejin.cn/column/${savedId}` };
      });
    });
  }

  async publish(options: PublishOptions) {
    const columnIds = options.columns ?? [];
    if (options.dryRun) {
      const draft = await this.client.draft(options.draft);
      validatePublishContent(draft.title, draft.mark_content);
      return { draft_id: draft.id, title: draft.title, column_ids: columnIds, dry_run: true };
    }
    return this.session.withWriteLock(async () => {
      const draft = await this.client.draft(options.draft);
      validatePublishContent(draft.title, draft.mark_content);
      return new OperationJournal(this.session.home).run('article.publish', { draft_id: options.draft, column_ids: columnIds }, async () => {
        const published = await this.client.publish(options.draft, columnIds);
        return { article_id: published.article_id, draft_id: options.draft, column_ids: columnIds, status: 'submitted', url: `https://juejin.cn/post/${published.article_id}` };
      });
    });
  }

  async checkIn(options: { dryRun?: boolean } = {}) {
    if (options.dryRun) {
      const done = await this.client.checkInStatus();
      return { date: checkInDate(), check_in_done: done, will_write: !done, dry_run: true };
    }
    return this.session.withWriteLock(async () => {
      const date = checkInDate();
      if (await this.client.checkInStatus()) return { date, status: 'already_checked_in' };
      return new OperationJournal(this.session.home).run('checkin.run', { date }, async () => ({
        date, status: 'checked_in', ...await this.client.checkIn(),
      }));
    });
  }

  async supplementCheckIn(date: string, options: { dryRun?: boolean } = {}) {
    const timestamp = supplementTimestamp(date);
    if (options.dryRun) return { date, timestamp, preview: await this.client.supplementPreview(timestamp), dry_run: true };
    return this.session.withWriteLock(async () => {
      await this.client.supplementPreview(timestamp);
      return new OperationJournal(this.session.home).run('checkin.supplement', { date, timestamp }, async () => ({
        date, status: 'supplemented', result: await this.client.supplementCheckIn(timestamp),
      }));
    });
  }

  async drawLottery(options: { count: 1 | 10; allowSpend?: boolean; dryRun?: boolean }) {
    // Free and paid single draws share one endpoint. Another client may consume the free chance after a preview.
    if (!options.dryRun && !options.allowSpend) {
      throw new CliError('INPUT', '抽奖接口可能扣除矿石，请先 --dry-run 查看，再明确传入 --allow-spend。');
    }
    const preview = async () => {
      const config = await this.client.lotteryConfig();
      const balance = await this.client.points();
      const estimated = options.count === 1 && config.free_count > 0 ? 0 : config.point_cost * options.count;
      return { draw_count: options.count, free_count: config.free_count, point_cost: config.point_cost, estimated_point_cost: estimated, balance };
    };
    if (options.dryRun) return { ...await preview(), dry_run: true };
    return this.session.withWriteLock(async () => {
      const plan = await preview();
      return new OperationJournal(this.session.home).run('lottery.draw', { draw_count: options.count }, async () => ({
        ...plan, status: 'drawn', result: await this.client.lotteryDraw(options.count),
      }));
    });
  }

  async dipLottery(historyId: string) {
    return this.session.withWriteLock(() => new OperationJournal(this.session.home).run(
      'lottery.dip', { lottery_history_id: historyId }, async () => ({
        status: 'dipped', lottery_history_id: historyId, result: await this.client.lotteryDip(historyId),
      })));
  }

  async drawLuckyLottery(options: { dryRun?: boolean } = {}) {
    if (options.dryRun) return { lucky: await this.client.lotteryLucky(), dry_run: true };
    return this.session.withWriteLock(() => new OperationJournal(this.session.home).run(
      'lottery.lucky_draw', {}, async () => ({ status: 'drawn', result: await this.client.lotteryLuckyDraw() })));
  }
}
