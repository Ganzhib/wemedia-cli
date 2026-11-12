import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, platformFixture } from './helpers.js';
import { CliError } from '../src/shared/errors.js';

// These fixtures exercise the same typed proof contract used by the real platform drivers.
test('a confirmed step resumes dependent work without repeating a successful upload', async t => {
  let uploads = 0, sends = 0;
  const one = platformFixture('one', async () => { sends++; throw new CliError('NETWORK', 'lost response'); }, {
    upload: async () => { uploads++; return { id: 'asset' }; },
    recover: async () => ({ verdict: 'effect_confirmed', value: { status: 'published', remote: { kind: 'entry', id: 'confirmed' } }, evidence: { source: 'server-receipt', message: 'Exact operation receipt' } }),
  });
  const { service } = await fixture(t, [one]);
  const job = await service.create('newsletter.send', { body: 'Frozen' }, ['one']);
  assert.equal((await service.run(job.id)).targets[0].status, 'unknown');
  const resumed = await service.run(job.id);
  assert.equal(resumed.targets[0].status, 'published');
  assert.equal(resumed.targets[0].steps.send.recovery?.verdict, 'effect_confirmed');
  assert.equal(uploads, 1); assert.equal(sends, 1);
});

test('only explicit not-applied evidence allows a failed write to execute again', async t => {
  let writes = 0;
  const one = platformFixture('one', async () => { if (++writes === 1) throw new CliError('NETWORK', 'lost response'); return { status: 'published' }; }, {
    recover: async () => ({ verdict: 'not_applied', evidence: { source: 'transaction-status', message: 'Server rejected this exact operation before applying it' } }),
  });
  const { service } = await fixture(t, [one]);
  const job = await service.create('newsletter.send', { body: 'Content' }, ['one']);
  await service.run(job.id);
  assert.equal((await service.refresh(job.id)).targets[0].steps['capability.execute'].phase, 'ready');
  assert.equal(writes, 1);
  assert.equal((await service.run(job.id)).targets[0].status, 'published');
  assert.equal(writes, 2);
});

test('draft existence cannot confirm an uncertain final publication', async t => {
  let writes = 0;
  const one = platformFixture('one', async () => { writes++; throw new CliError('NETWORK', 'lost publish response'); }, {
    recover: async () => ({ verdict: 'effect_confirmed', value: { status: 'draft_saved', remote: { kind: 'draft', id: 'saved' } }, evidence: { source: 'draft.get', message: 'Draft exists' } }),
  });
  const { service } = await fixture(t, [one]);
  const job = await service.create('newsletter.send', { body: 'Content' }, ['one']);
  await service.run(job.id);
  assert.equal((await service.refresh(job.id)).targets[0].executionStatus, 'unknown');
  assert.equal((await service.run(job.id)).targets[0].status, 'unknown');
  assert.equal(writes, 1);
});

test('later deletion observations never erase a confirmed historical submission', async t => {
  const one = platformFixture('one', async () => ({ status: 'published', remote: { kind: 'entry', id: 'id' } }), {
    inspect: async () => ({ state: 'deleted', remote: { kind: 'entry', id: 'id' }, message: 'Exact server tombstone' }),
  });
  const { service } = await fixture(t, [one]);
  const job = await service.create('newsletter.send', { body: 'Content' }, ['one']);
  await service.run(job.id);
  const refreshed = await service.refresh(job.id);
  assert.equal(refreshed.targets[0].status, 'published');
  assert.equal(refreshed.targets[0].observation?.result.state, 'deleted');
  assert.equal((await service.publications.get(refreshed.targets[0].operationId)).result?.status, 'published');
});

test('verification metadata contains a safe resource and can resume after confirmed evidence', async t => {
  let writes = 0;
  const one = platformFixture('one', async context => {
    writes++; await context.remember({ kind: 'draft', id: 'id' });
    throw new CliError('VERIFICATION', 'scan required', { verification: { kind: 'administrator_scan', strategy: 'inspect', resource: { kind: 'draft', id: 'id' } } });
  }, { recover: async (_context, _input, saved) => {
    assert.equal(saved.verification?.kind, 'administrator_scan');
    assert.equal(saved.references[0].id, 'id');
    return { verdict: 'effect_confirmed', value: { status: 'published', remote: { kind: 'entry', id: 'id' } }, evidence: { source: 'verification-result', message: 'Original request completed' } };
  } });
  const { service } = await fixture(t, [one]);
  const job = await service.create('newsletter.send', { body: 'Content' }, ['one']);
  const waiting = await service.run(job.id);
  assert.equal(waiting.targets[0].status, 'waiting_for_verification');
  assert.equal(waiting.targets[0].requiredAction, 'scan_in_browser');
  assert.match(waiting.targets[0].verification!.id, /^[a-f0-9-]+$/);
  assert.ok(!JSON.stringify(waiting.targets[0].verification).includes('Cookie'));
  assert.equal((await service.run(job.id)).targets[0].status, 'published');
  assert.equal(writes, 1);
});

test('one failed recovery leaves another target free to record its observation', async t => {
  const one = platformFixture('one', async () => ({ status: 'published', remote: { kind: 'entry', id: 'one' } }), { inspect: async () => { throw new CliError('NETWORK', 'unavailable'); } });
  const two = platformFixture('two', async () => ({ status: 'published', remote: { kind: 'entry', id: 'two' } }), { inspect: async () => ({ state: 'published' }) });
  const { service } = await fixture(t, [one, two]);
  const job = await service.create('newsletter.send', { body: 'Content' }, ['one', 'two']); await service.run(job.id);
  const result = await service.refresh(job.id);
  assert.match(result.targets[0].observation!.error.message, /unavailable/);
  assert.equal(result.targets[1].observation?.result.state, 'published');
});
