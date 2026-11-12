import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JuejinClient } from '../src/platform/juejin/client.js';
import { JuejinHttp } from '../src/platform/juejin/http.js';
import { ImageUploader } from '../src/platform/juejin/imagex.js';
import { SessionStore } from '../src/platform/juejin/session.js';
import { DraftService } from '../src/platform/juejin/draft-service.js';
import { WritingService } from '../src/platform/juejin/writing-service.js';
import { CliError } from '../src/shared/errors.js';
import { readArticle } from '../src/content/markdown.js';

function writing(home: string, fetch: typeof globalThis.fetch) {
  const http = new JuejinHttp({ fetch });
  const client = new JuejinClient(http);
  const uploader = new ImageUploader(http);
  return new WritingService(client, uploader, new SessionStore(home), new DraftService(client, uploader));
}

test('Juejin prepares the frozen document even if the source changes while authentication runs', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wm-frozen-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, 'article.md');
  await writeFile(file, '# Original\n\nFrozen content.');
  const document = await readArticle(file);
  await writeFile(file, '# Edited\n\nDifferent content.');
  const http = new JuejinHttp({ fetch: async () => Response.json({ err_no: 0, data: [{ category_id: '1', category_name: '前端', category_url: 'frontend' }] }) });
  const drafts = new DraftService(new JuejinClient(http), new ImageUploader(http));
  const plan = await drafts.prepareDocument(document, { title: 'Original', brief: '这是一段用于验证冻结文稿的摘要，确认准备任务之后修改源文件不会在认证结束后意外发布新内容，发布始终使用用户先前核对过的内容。', category: '1', tags: ['2'] });
  assert.equal(plan.input.title, 'Original');
  assert.equal(plan.input.mark_content.trim(), 'Frozen content.');
});

test('column updates merge editable metadata under the write lock and preserve the ID', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-writing-'));
  const requests: unknown[] = [];
  try {
    const service = writing(home, async (_url, init) => {
      await readFile(join(home, 'write.lock')); // Both read and write run under the same account lock.
      if (!init?.body) return Response.json({ err_no: 0, data: { column_version: { title: '旧标题', content: '保留简介', cover: 'https://example.com/cover.png' } } });
      requests.push(JSON.parse(init.body as string));
      return Response.json({ err_no: 0, data: null });
    });
    const result = await service.saveColumn({ title: '新标题' }, '123');
    assert.equal(result.column_id, '123');
    assert.deepEqual(requests, [{ column_id: '123', title: '新标题', content: '保留简介', cover: 'https://example.com/cover.png' }]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('publish dry run only reads; a failed publish retains target IDs without replay', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-writing-'));
  let publishes = 0;
  try {
    const service = writing(home, async url => {
      if (String(url).endsWith('/article_draft/detail')) return Response.json({ err_no: 0, data: { article_draft: { id: '123', title: '待发布文章', mark_content: '这篇文章解释真实的设计取舍。' } } });
      publishes++;
      throw new TypeError('socket closed');
    });
    assert.deepEqual(await service.publish({ draft: '123', columns: ['456'], dryRun: true }), { draft_id: '123', title: '待发布文章', column_ids: ['456'], dry_run: true });
    assert.equal(publishes, 0);
    await assert.rejects(() => readFile(join(home, 'operations.jsonl')), { code: 'ENOENT' });
    await assert.rejects(() => service.publish({ draft: '123', columns: ['456'] }), (error: CliError) => {
      assert.equal(error.code, 'NETWORK');
      assert.equal(error.details?.draft_id, '123');
      assert.deepEqual(error.details?.column_ids, ['456']);
      return true;
    });
    assert.equal(publishes, 1);
    const receipts = (await readFile(join(home, 'operations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(receipts.map(receipt => receipt.phase), ['started', 'failed_or_unknown']);
  } finally { await rm(home, { recursive: true, force: true }); }
});
