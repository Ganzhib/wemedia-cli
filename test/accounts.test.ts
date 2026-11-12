import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, platformFixture } from './helpers.js';
import { writeJson } from '../src/runtime/storage.js';
import { CliError } from '../src/shared/errors.js';

test('two login aliases for the same real identity share one binding, generation and lock', async t => {
  const one = platformFixture('one', async () => ({ status: 'published' }));
  const { accounts } = await fixture(t, [one]);
  const identity = await accounts.resolve('one');
  await accounts.login('one', 'work', directory => one.platform.login(directory));
  assert.deepEqual(await accounts.resolve('one', 'work'), identity);
  await accounts.use(identity, async first => {
    const work = await accounts.resolve('one', 'work');
    await assert.rejects(accounts.use(work, async () => undefined), (error: CliError) => error.code === 'BUSY');
    assert.ok(first.directory.includes((await accounts.binding(work)).sessionId));
  });
});

test('failed or wrong-account login never overwrites the working binding or credentials', async t => {
  const one = platformFixture('one', async () => ({ status: 'published' }));
  const { accounts } = await fixture(t, [one]);
  const identity = await accounts.resolve('one');
  const before = await accounts.binding(identity);
  await assert.rejects(accounts.login('one', 'main', async () => ({ id: 'other', name: 'Wrong' })), (error: CliError) => error.code === 'AUTH');
  await assert.rejects(accounts.login('one', 'main', async () => { throw new Error('closed'); }), /closed/);
  assert.deepEqual(await accounts.binding(identity), before);
  await accounts.use(identity, async account => assert.equal(JSON.parse(await readFile(join(account.directory, 'profile.json'), 'utf8')).id, 'one-id'));
});

test('same remote ID on different platforms never shares an account lock', async t => {
  const { accounts } = await fixture(t, []);
  for (const platform of ['one', 'two']) await accounts.login(platform, 'main', async () => ({ id: 'same-id', name: platform }));
  const one = await accounts.resolve('one'), two = await accounts.resolve('two');
  assert.notEqual(one.bindingId, two.bindingId);
  await accounts.use(one, async () => assert.equal(await accounts.use(two, async () => 42), 42));
});

test('old alias-based directories are never scanned or migrated', async t => {
  const { accounts, home } = await fixture(t, []);
  await mkdir(join(home, 'accounts', 'old-platform', 'main'), { recursive: true });
  await writeJson(join(home, 'accounts', 'old-platform', 'main', 'account.json'), { id: 'old-id', name: 'Old' });
  assert.deepEqual(await accounts.list(), []);
  await assert.rejects(accounts.resolve('old-platform'), (error: CliError) => error.code === 'AUTH');
  await assert.rejects(accounts.resolve('../outside'), (error: CliError) => error.code === 'INPUT');
});

test('reauthentication restores the frozen identity after its old alias points elsewhere', async t => {
  const one = platformFixture('one', async () => ({ status: 'published' }));
  const { accounts } = await fixture(t, [one]);
  const original = await accounts.resolve('one'); const before = await accounts.binding(original);
  await accounts.login('one', 'other', async directory => { const profile = { id: 'other-id', name: 'Other' }; await writeJson(join(directory, 'profile.json'), profile); return profile; });
  await accounts.alias('one', 'other', 'main', true);
  await assert.rejects(accounts.reauthenticate('one', original.bindingId, async () => ({ id: 'wrong-id', name: 'Wrong' })), (error: CliError) => error.code === 'AUTH');
  assert.equal((await accounts.binding(original)).sessionId, before.sessionId);
  const restored = await accounts.reauthenticate('one', original.bindingId, directory => one.platform.login(directory));
  assert.notEqual(restored.sessionId, before.sessionId);
  assert.deepEqual(restored.identity, original);
  assert.equal((await accounts.resolve('one')).accountId, 'other-id');
  await assert.rejects(accounts.reauthenticate('two', original.bindingId, async () => { throw new Error('must not open'); }), (error: CliError) => error.code === 'AUTH');
});
