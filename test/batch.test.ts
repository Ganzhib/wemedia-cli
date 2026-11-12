import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WritingService } from '../src/platform/juejin/writing-service.js';
import { DraftService } from '../src/platform/juejin/draft-service.js';
import { JuejinClient } from '../src/platform/juejin/client.js';
import { JuejinHttp } from '../src/platform/juejin/http.js';
import { ImageUploader } from '../src/platform/juejin/imagex.js';
import { SessionStore } from '../src/platform/juejin/session.js';

test('batch preflights all files, resumes completed work and refuses unknown writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'juejin-batch-'));
  const http = new JuejinHttp();
  const client = new JuejinClient(http);
  const uploader = new ImageUploader(http);
  const drafts = new DraftService(client, uploader);
  const service = new WritingService(client, uploader, new SessionStore(directory), drafts);
  let invalid = true;
  let writes = 0;
  drafts.prepare = async file => {
    if (invalid && file.endsWith('b.md')) throw new Error('bad input');
    return { input: { title: 'test', brief_content: 'test', category_id: '1', tag_ids: ['2'], cover_image: '', mark_content: 'test' }, directory, localImages: [] };
  };
  service.saveDraft = async () => { writes++; return { draft_id: String(writes), preview_url: '' }; };
  service.publish = async options => { writes++; return { article_id: String(writes), draft_id: options.draft, column_ids: ['9'], status: 'submitted', url: '' }; };
  try {
    await writeFile(join(directory, 'a.md'), 'A');
    await writeFile(join(directory, 'b.md'), 'B');
    await assert.rejects(service.publishDirectory(directory, { column: '9' }), /bad input/);
    assert.equal(writes, 0);
    invalid = false;
    await service.publishDirectory(directory, { column: '9' });
    assert.equal(writes, 4);
    await service.publishDirectory(directory, { column: '9' });
    assert.equal(writes, 4);
    await rm(join(directory, '.juejin-batch.json'));
    service.publish = async () => { writes++; throw new Error('timeout'); };
    await assert.rejects(service.publishDirectory(directory, { column: '9' }), /timeout/);
    const before = writes;
    await assert.rejects(service.publishDirectory(directory, { column: '9' }), /尚未确认/);
    assert.equal(writes, before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
