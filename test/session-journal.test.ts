import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, parseCookies } from '../src/platform/juejin/session.js';
import { OperationJournal } from '../src/runtime/journal.js';
import { CliError } from '../src/shared/errors.js';

const imported = JSON.stringify([
  { name: 'sessionid', value: 'private', domain: '.juejin.cn' },
  { name: 'unrelated', value: 'other', domain: 'example.com' },
]);

test('imports only platform cookies and rejects expired authentication', () => {
  assert.equal(parseCookies(imported).length, 1);
  assert.equal(parseCookies(JSON.stringify({ cookies: JSON.parse(imported) }))[0].name, 'sessionid');
  assert.throws(() => parseCookies('[{"name":"sessionid","value":"x","domain":".juejin.cn","expires":1}]'), /未找到有效/);
  assert.throws(() => parseCookies('[{"name":"sessionid","value":"x\\r\\nInjected: x","domain":".juejin.cn"}]'), /非法字符/);
});

test('stores session privately and releases a shared write lock after failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-session-'));
  try {
    const first = new SessionStore(home);
    const second = new SessionStore(home);
    await first.save(parseCookies(imported));
    assert.equal((await first.load())[0].value, 'private');
    if (process.platform !== 'win32') assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    await assert.rejects(() => first.withWriteLock(async () => {
      await assert.rejects(() => second.withWriteLock(async () => 1), (error: CliError) => error.code === 'BUSY');
      throw new Error('operation failed');
    }), /operation failed/);
    assert.equal(await second.withWriteLock(async () => 42), 42);
    await first.clear();
    assert.deepEqual(await first.load(false), []);
    await assert.rejects(() => first.load(), (error: CliError) => error.code === 'AUTH');
  } finally { await rm(home, { recursive: true }); }
});

test('records an uncertain publication with its existing draft and columns', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-journal-'));
  try {
    const journal = new OperationJournal(home);
    await assert.rejects(() => journal.run('article.publish', { draft_id: '123', column_ids: ['456'] }, async () => {
      throw new CliError('NETWORK', 'timeout');
    }), (error: CliError) => error.details!.draft_id === '123' && typeof error.details!.operation_id === 'string');
    const records = (await readFile(join(home, 'operations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records[0].phase, 'started');
    assert.equal(records[1].phase, 'failed_or_unknown');
    assert.deepEqual(records[1].column_ids, ['456']);
  } finally { await rm(home, { recursive: true }); }
});
