import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JuejinClient } from '../src/platform/juejin/client.js';
import { JuejinHttp } from '../src/platform/juejin/http.js';
import { ImageUploader } from '../src/platform/juejin/imagex.js';
import { DraftService } from '../src/platform/juejin/draft-service.js';
import { readArticle } from '../src/content/markdown.js';

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
