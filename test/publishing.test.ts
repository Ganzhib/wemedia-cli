import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, platformFixture } from './helpers.js';
import { writeJson } from '../src/runtime/storage.js';
import { CliError } from '../src/shared/errors.js';

const input = { body: 'Original content' };
test('a custom capability executes without article fields or platform branches', async t => {
  let writes = 0;
  const platform = platformFixture('newsletter', async (context, payload) => {
    writes++;
    assert.equal(payload.body, input.body);
    assert.equal(context.account.identity.accountId, 'newsletter-id');
    return { status: 'published', remote: { kind: 'newsletter-entry', id: 'entry-1' } };
  });
  const { service, home } = await fixture(t, [platform]);
  const job = await service.create('newsletter.send', input, ['newsletter']);
  assert.equal((await service.run(job.id)).targets[0].remote?.kind, 'newsletter-entry');
  await service.run(job.id);
  assert.equal(writes, 1);
  assert.deepEqual(platform.counts, { sessions: 1, closes: 1 });
  if (process.platform !== 'win32') assert.equal((await stat(join(home, 'jobs', job.id, 'job.json'))).mode & 0o777, 0o600);
});

test('unsupported capabilities and malformed input fail before opening any session', async t => {
  const one = platformFixture('one', async () => ({ status: 'published' }));
  const { service } = await fixture(t, [one]);
  await assert.rejects(service.create('draft.create', input, ['one']), (error: CliError) => error.code === 'UNSUPPORTED');
  await assert.rejects(service.invoke('one', 'main', 'newsletter.send', { body: 1 }), (error: CliError) => error.code === 'INPUT');
  await assert.rejects(service.invoke('one', 'main', 'unregistered', {}), (error: CliError) => error.code === 'UNSUPPORTED');
  assert.equal(one.counts.sessions, 0);
});

test('same identities deduplicate aliases and reordered destinations', async t => {
  const one = platformFixture('one', async () => ({ status: 'published' }));
  const two = platformFixture('two', async () => ({ status: 'published' }));
  const { accounts, service } = await fixture(t, [one, two]);
  await accounts.alias('one', 'main', 'work');
  const first = await service.create('newsletter.send', input, ['one', 'two']);
  assert.equal((await service.create('newsletter.send', input, ['two', 'one:work'])).id, first.id);
  assert.equal((await service.create('newsletter.send', input, ['one', 'one:work'])).targets.length, 1);
  assert.notEqual((await service.create('newsletter.send', input, ['one', 'two'], true)).id, first.id);
});

test('plans keep the real account after an alias is explicitly rebound', async t => {
  const sentTo: string[] = [];
  const one = platformFixture('one', async context => { sentTo.push(context.account.identity.accountId); return { status: 'published' }; });
  const { accounts, service } = await fixture(t, [one]);
  const job = await service.create('newsletter.send', input, ['one']);
  await accounts.login('one', 'other', async directory => {
    await writeJson(join(directory, 'profile.json'), { id: 'other-id', name: 'Other' });
    return { id: 'other-id', name: 'Other' };
  });
  await accounts.alias('one', 'other', 'main', true);
  await service.run(job.id);
  assert.deepEqual(sentTo, ['one-id']);
  assert.equal((await accounts.resolve('one')).accountId, 'other-id');
});

test('a wrong observed identity stops execution and closes the connection', async t => {
  let writes = 0;
  const one = platformFixture('one', async () => { writes++; return { status: 'published' }; }, { observedId: 'someone-else' });
  const { service } = await fixture(t, [one]);
  const job = await service.create('newsletter.send', input, ['one']);
  const result = await service.run(job.id);
  assert.equal(result.targets[0].status, 'rejected');
  assert.match(result.targets[0].message!, /身份/);
  assert.equal(writes, 0);
  assert.equal(one.counts.closes, 1);
});

test('an uncertain direct write is durably recorded even without driver step calls', async t => {
  let writes = 0;
  const one = platformFixture('one', async () => ({ status: 'published' }));
  const two = platformFixture('two', async () => { writes++; throw new CliError('NETWORK', 'response lost'); });
  const { service, home } = await fixture(t, [one, two]);
  const job = await service.create('newsletter.send', input, ['one', 'two']);
  assert.deepEqual((await service.run(job.id)).targets.map(target => target.status), ['published', 'unknown']);
  await service.run(job.id);
  assert.equal(writes, 1);
  const events = await readFile(join(home, 'jobs', job.id, 'events.jsonl'), 'utf8');
  assert.ok(!events.includes('Original content'));
  assert.ok(!events.includes('Cookie'));
});

test('explicit rejection can resume without repeating a successful inner upload', async t => {
  let uploads = 0, writes = 0;
  const one = platformFixture('one', async context => {
    await context.step('upload', async () => { uploads++; return { id: 'asset' }; });
    return context.step('send', async () => {
      writes++;
      if (writes === 1) throw new CliError('API', 'rejected', { outcome: 'rejected' });
      return { status: 'published' };
    });
  });
  const { service } = await fixture(t, [one]);
  const job = await service.create('newsletter.send', input, ['one']);
  assert.equal((await service.run(job.id)).targets[0].status, 'rejected');
  assert.equal((await service.run(job.id)).targets[0].status, 'published');
  assert.equal(uploads, 1); assert.equal(writes, 2);
});

test('interrupted running steps and incomplete remote evidence never cause a new write', async t => {
  let writes = 0;
  const one = platformFixture('one', async () => { writes++; return { status: 'published' }; }, { inspect: async () => ({ status: 'draft_saved', remote: { kind: 'draft', id: 'saved' } }) });
  const { service, home } = await fixture(t, [one]);
  const job = await service.create('newsletter.send', input, ['one']);
  job.targets[0].steps.send = { phase: 'running' }; job.targets[0].remote = { kind: 'draft', id: 'saved' };
  await writeJson(join(home, 'jobs', job.id, 'job.json'), job);
  assert.equal((await service.run(job.id)).targets[0].status, 'unknown');
  assert.equal((await service.refresh(job.id)).targets[0].status, 'unknown');
  await service.run(job.id); assert.equal(writes, 0);
});

test('generic reads preserve zero and false and reuse a single verified session', async t => {
  const one = platformFixture('one', async () => ({ status: 'published' }));
  const { service } = await fixture(t, [one]);
  assert.deepEqual(await service.invoke('one', 'main', 'newsletter.metrics', {}), { effect: 'read', value: { total: 0, enabled: false } });
  assert.deepEqual(one.counts, { sessions: 1, closes: 1 });
});

test('stored payloads and driver revisions are checked before any connection', async t => {
  const one = platformFixture('one', async () => ({ status: 'published' }));
  const { service, home } = await fixture(t, [one]);
  const job = await service.create('newsletter.send', input, ['one']);
  job.targets[0].variantId = '0'.repeat(64);
  await writeJson(join(home, 'jobs', job.id, 'job.json'), job);
  await assert.rejects(service.run(job.id), (error: CliError) => error.code === 'INPUT');
  job.targets[0].variantId = (await service.planning.get(job.planId)).targets[0].variantId; job.targets[0].driver.version = 'different';
  assert.equal(one.platform.driver.version, '2');
  await writeJson(join(home, 'jobs', job.id, 'job.json'), job);
  assert.equal((await service.get(job.id)).id, job.id);
  await assert.rejects(service.run(job.id), /版本/);
  assert.equal(one.counts.sessions, 0);
});
