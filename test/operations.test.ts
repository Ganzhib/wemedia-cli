import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, platformFixture } from './helpers.js';

test('partially overlapping target batches share authoritative operations and new copies get fresh dependencies', async t => {
  const counts = { one: 0, two: 0, three: 0 };
  const platforms = (['one', 'two', 'three'] as const).map(id => platformFixture(id, async () => { counts[id]++; return { status: 'published' }; }));
  const { service } = await fixture(t, platforms);
  const input = { body: 'Shared content' };
  const first = await service.create('newsletter.send', input, ['one', 'two']);
  await service.run(first.id);
  const second = await service.create('newsletter.send', input, ['one', 'three']);
  const result = await service.run(second.id);
  assert.equal(result.targets[0].operationId, first.targets[0].operationId);
  assert.deepEqual(counts, { one: 1, two: 1, three: 1 });
  assert.deepEqual(platforms.map(platform => platform.counts.sessions), [1, 1, 1]);
  const copy = await service.create('newsletter.send', input, ['one', 'three'], true);
  await service.run(copy.id);
  assert.notEqual(copy.targets[0].operationId, first.targets[0].operationId);
  assert.deepEqual(counts, { one: 2, two: 1, three: 2 });
});

test('failed projections and events cannot erase successful effects or trigger another write', async t => {
  let writes = 0;
  const one = platformFixture('one', async () => { writes++; return { status: 'published', remote: { kind: 'entry', id: 'published' } }; });
  const { service, home } = await fixture(t, [one]);
  const job = await service.create('newsletter.send', { body: 'Content' }, ['one']);
  await mkdir(join(home, 'jobs', job.id, 'summary.json'));
  await mkdir(join(home, 'jobs', job.id, 'events.jsonl'));
  const result = await service.run(job.id);
  assert.equal(result.targets[0].status, 'published');
  assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.reason), ['summary_projection_failed', 'event_log_failed']);
  assert.equal((await service.get(job.id)).targets[0].remote?.id, 'published');
  await service.run(job.id); assert.equal(writes, 1);
  await rm(join(home, 'jobs', job.id, 'summary.json'), { recursive: true });
  await writeFile(join(home, 'jobs', job.id, 'summary.json'), '{broken projection');
  assert.equal((await service.get(job.id)).targets[0].status, 'published');
});

test('a missing success receipt after a real effect stays unknown and cannot replay in another batch', async t => {
  let writes = 0;
  const one = platformFixture('one', async () => { writes++; return { status: 'published' }; });
  const two = platformFixture('two', async () => ({ status: 'published' }));
  const { service } = await fixture(t, [one, two]);
  const persist = service.operations.save.bind(service.operations); let fail = true;
  service.operations.save = async record => {
    if (record.target.identity.platformId === 'one' && record.steps['capability.execute']?.phase === 'succeeded' && fail) { fail = false; throw new Error('disk full'); }
    await persist(record);
  };
  const first = await service.create('newsletter.send', { body: 'Content' }, ['one']);
  assert.equal((await service.run(first.id)).targets[0].status, 'unknown');
  const next = await service.create('newsletter.send', { body: 'Content' }, ['one', 'two']);
  assert.deepEqual((await service.run(next.id)).targets.map(target => target.status), ['unknown', 'published']);
  assert.equal(writes, 1);
});

test('publication indexes rebuild from authoritative references without repeating effects', async t => {
  let writes = 0;
  const one = platformFixture('one', async context => { writes++; await context.remember({ kind: 'draft', id: 'draft' }); return { status: 'published', remote: { kind: 'article', id: 'article' } }; });
  const { service, home } = await fixture(t, [one]);
  const job = await service.create('newsletter.send', { body: 'Content' }, ['one']);
  await mkdir(join(home, 'indexes'), { recursive: true });
  await writeFile(join(home, 'indexes', 'publications'), 'blocked');
  const result = await service.run(job.id);
  assert.equal(result.targets[0].status, 'published');
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.reason === 'publication_index_failed'));
  const rebuilt = await service.publications.rebuild();
  assert.deepEqual(rebuilt[0].references.map(reference => reference.kind), ['draft', 'article']);
  await rm(join(home, 'indexes'), { recursive: true });
  assert.equal((await service.publications.get(rebuilt[0].id)).revisions[0].result?.status, 'published');
  await service.publications.rebuild();
  assert.equal((await service.publications.list()).length, 1);
  await service.run(job.id); assert.equal(writes, 1);
});

test('overlapping concurrent jobs cannot bypass account and operation locks', async t => {
  let writes = 0, entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const one = platformFixture('one', async () => { writes++; entered(); await gate; return { status: 'published' }; });
  const two = platformFixture('two', async () => ({ status: 'published' }));
  const { service } = await fixture(t, [one, two]);
  const first = await service.create('newsletter.send', { body: 'Same' }, ['one']);
  const second = await service.create('newsletter.send', { body: 'Same' }, ['one', 'two']);
  const pending = service.run(first.id); await started;
  try { assert.equal((await service.run(second.id)).targets[1].status, 'published'); }
  finally { finish(); await pending; }
  assert.deepEqual((await service.run(second.id)).targets.map(target => target.status), ['published', 'published']);
  assert.equal(writes, 1);
});

test('an explicit rejected result can resume while an unknown result never replays', async t => {
  let rejectedAttempts = 0, unknownAttempts = 0;
  const one = platformFixture('one', async () => ++rejectedAttempts === 1 ? { status: 'rejected' } : { status: 'published' });
  const two = platformFixture('two', async () => { unknownAttempts++; return { status: 'unknown' }; });
  const { service } = await fixture(t, [one, two]);
  const job = await service.create('newsletter.send', { body: 'Content' }, ['one', 'two']);
  assert.deepEqual((await service.run(job.id)).targets.map(target => target.status), ['rejected', 'unknown']);
  assert.deepEqual((await service.run(job.id)).targets.map(target => target.status), ['published', 'unknown']);
  assert.equal(rejectedAttempts, 2); assert.equal(unknownAttempts, 1);
});
