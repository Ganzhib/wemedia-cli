import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { fixture, platformFixture } from './helpers.js';
import { resourceSnapshot, resourceBaseline, requireVersion, contentChanges } from '../src/content/resources.js';
import { UploadCache } from '../src/runtime/uploads.js';
import { ObjectStore } from '../src/runtime/objects.js';
import { CliError } from '../src/shared/errors.js';

test('version conflicts expose exact field and image order differences; timestamps do not change the baseline', () => {
  const original = resourceSnapshot({ kind: 'draft', id: 'same' }, 'draft', { title: 'first', images: ['a', 'b'] });
  const reread = { ...original, observedAt: 'later' };
  assert.deepEqual(resourceBaseline(reread), resourceBaseline(original));
  requireVersion(original, reread);
  const changed = resourceSnapshot(original.resource, 'draft', { title: 'edited elsewhere', images: ['b', 'a'] });
  assert.throws(() => requireVersion(original, changed), (error: CliError) => {
    assert.equal(error.code, 'CONFLICT'); assert.equal(error.details?.outcome, 'rejected');
    assert.deepEqual(error.details?.changes, contentChanges(original.data, changed.data)); return true;
  });
  assert.throws(() => requireVersion({ ...original, version: 'forged' }, changed), /摘要不匹配/);
});

test('upload reuse is isolated by real identity, purpose, protocol and bytes and respects expiry', async t => {
  const { home } = await fixture(t, []); let uploads = 0, checks = 0;
  const artifact = await new ObjectStore(home).put(Buffer.from('bytes'), 'image/png', '.png');
  const identity = { bindingId: 'a'.repeat(32), platformId: 'custom', accountId: 'one' };
  const schema = z.object({ id: z.string() });
  const hooks = { upload: async () => ({ value: { id: String(++uploads) }, expiresAt: Date.now() + 60_000 }), revalidate: async () => { checks++; return undefined; } };
  const cache = new UploadCache(home, identity, () => undefined);
  assert.equal((await cache.use(artifact, 'body', 'v1', schema, hooks)).id, '1');
  assert.equal((await cache.use(artifact, 'body', 'v1', schema, hooks)).id, '1');
  await cache.use(artifact, 'cover', 'v1', schema, hooks);
  await cache.use(artifact, 'body', 'v2', schema, hooks);
  await new UploadCache(home, { ...identity, accountId: 'two', bindingId: 'b'.repeat(32) }, () => undefined).use(artifact, 'body', 'v1', schema, hooks);
  const changed = await new ObjectStore(home).put(Buffer.from('different'), 'image/png', '.png');
  await cache.use(changed, 'body', 'v1', schema, hooks);
  assert.equal(uploads, 5); assert.equal(checks, 0);
  const expiring = { ...hooks, upload: async () => ({ value: { id: String(++uploads) }, expiresAt: 0 }) };
  await cache.use(artifact, 'expired', 'v1', schema, expiring);
  await cache.use(artifact, 'expired', 'v1', schema, expiring);
  assert.equal(checks, 1); assert.equal(uploads, 7);
});

test('uploads without advertised validity are revalidated, and cache write failure cannot erase their receipt', async t => {
  const { home } = await fixture(t, []); const warnings: string[] = []; let uploads = 0, checks = 0;
  const artifact = await new ObjectStore(home).put(Buffer.from('bytes'), 'image/png');
  const identity = { bindingId: 'a'.repeat(32), platformId: 'custom', accountId: 'one' };
  const schema = z.string(); const cache = new UploadCache(home, identity, reason => warnings.push(reason));
  const hooks = { upload: async () => ({ value: 'receipt-' + ++uploads }), revalidate: async (value: string) => { checks++; return { value }; } };
  await cache.use(artifact, 'body', 'v1', schema, hooks); await cache.use(artifact, 'body', 'v1', schema, hooks);
  assert.equal(uploads, 1); assert.equal(checks, 1);
  const [cachedFile] = await readdir(join(home, 'cache', 'uploads'));
  const cachePath = join(home, 'cache', 'uploads', cachedFile); const validCache = await readFile(cachePath);
  await writeFile(cachePath, 'invalid JSON');
  await assert.rejects(cache.use(artifact, 'body', 'v1', schema, hooks), (error: CliError) => error.code === 'INPUT' && error.details?.outcome === undefined);
  assert.equal(uploads, 1); await writeFile(cachePath, validCache);
  // Block projection creation after a confirmed upload, without corrupting a cache read.
  const freshHome = join(home, 'fresh');
  const failing = new UploadCache(freshHome, identity, reason => warnings.push(reason));
  const result = await failing.use(artifact, 'body', 'v1', schema, { ...hooks, upload: async () => {
    await mkdir(join(freshHome, 'cache'), { recursive: true }); await writeFile(join(freshHome, 'cache', 'uploads'), 'blocked'); return { value: 'confirmed' };
  } });
  assert.equal(result, 'confirmed'); assert.deepEqual(warnings, ['upload_cache_write_failed']);
});

test('publication lineage joins exact resources across revisions while preserving historical success and failed observations', async t => {
  const custom = platformFixture('custom', async (context, input) => {
    await context.remember({ kind: 'draft', id: 'stable' }); await context.remember({ kind: 'upload', id: input.body }, 'asset');
    return { status: 'published', remote: { kind: 'article', id: 'published' } };
  });
  const { service } = await fixture(t, [custom]);
  for (const body of ['first', 'second']) await service.run((await service.create('newsletter.send', { body }, ['custom'])).id);
  const publications = await service.publications.list(); assert.equal(publications.length, 1);
  assert.equal(publications[0].revisions.length, 2); assert.equal(publications[0].references.length, 2);
  const refreshed = await service.publications.refresh(publications[0].id, async () => { throw new CliError('NETWORK', 'offline'); });
  assert.equal(refreshed.revisions[0].result?.status, 'published'); assert.ok(refreshed.observation && 'error' in refreshed.observation);
  assert.equal((await service.publications.rebuild())[0].id, publications[0].id);
});
