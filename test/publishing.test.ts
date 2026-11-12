import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlatformRegistry } from '../src/core/registry.js';
import type { PlatformAdapter, OperationContext, OperationResult } from '../src/core/types.js';
import { PublishingService } from '../src/services/publishing.js';
import { AccountStore } from '../src/runtime/accounts.js';
import { documentAssets } from '../src/content/document.js';
import { writeJson } from '../src/runtime/storage.js';
import { CliError } from '../src/shared/errors.js';

function adapter(id: string, run: (context: OperationContext) => Promise<OperationResult>): PlatformAdapter {
  return {
    id, name: id, driver: id + '.test', version: '1', operations: { publish: { description: 'publish', run } },
    prepare: async (document, options) => ({ title: String(options.title ?? 'Title'), body: document.markdown, format: 'markdown', assets: await documentAssets(document, options), options: {} }),
    login: async () => ({ id: id + '-id', name: id }), status: async () => ({ id: id + '-id', name: id }), lists: {},
  };
}

async function fixture(t: TestContext, adapters: PlatformAdapter[]) {
  const home = await mkdtemp(join(tmpdir(), 'wm-jobs-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, 'article.md');
  await writeFile(file, '# Title\n\nOriginal content.');
  for (const platform of adapters) await new AccountStore(home, platform.id).save({ id: platform.id + '-id', name: platform.id });
  return { home, file, service: new PublishingService(home, new PlatformRegistry(adapters)) };
}

test('multi-platform preparation rejects unsupported targets before any side effect', async t => {
  let writes = 0;
  const a = adapter('one', async () => { writes++; return { status: 'published' }; });
  const b = adapter('two', async () => ({ status: 'published' }));
  b.operations = {};
  const { service, file } = await fixture(t, [a, b]);
  await assert.rejects(service.create(file, ['one', 'two'], 'publish'), (error: CliError) => error.code === 'UNSUPPORTED');
  assert.equal(writes, 0);
});

test('identical plans deduplicate and completed steps never execute twice', async t => {
  let writes = 0;
  const platform = adapter('one', context => context.step('publish', async () => {
    writes++;
    return { status: 'published', remote: { kind: 'article', id: 'remote-id' } };
  }));
  const { service, file, home } = await fixture(t, [platform]);
  const first = await service.create(file, ['one'], 'publish');
  const second = await service.create(file, ['one:main'], 'publish');
  assert.equal(first.id, second.id);
  assert.equal((await service.run(first.id)).targets[0].status, 'published');
  await service.run(first.id);
  assert.equal(writes, 1);
  const fresh = await service.create(file, ['one'], 'publish', {}, true);
  assert.notEqual(fresh.id, first.id);
  if (process.platform !== 'win32') assert.equal((await stat(join(home, 'jobs', first.id, 'job.json'))).mode & 0o777, 0o600);
});

test('one platform can succeed while an uncertain write on another is never replayed', async t => {
  const writes = { one: 0, two: 0 };
  const one = adapter('one', context => context.step('publish', async () => { writes.one++; return { status: 'published' }; }));
  const two = adapter('two', context => context.step('publish', async () => { writes.two++; throw new CliError('NETWORK', 'response lost'); }));
  const { service, file } = await fixture(t, [one, two]);
  const job = await service.create(file, ['one', 'two'], 'publish');
  const result = await service.run(job.id);
  assert.deepEqual(result.targets.map(target => target.status), ['published', 'unknown']);
  await service.run(job.id);
  assert.deepEqual(writes, { one: 1, two: 1 });
});

test('reordering the same destinations cannot create duplicate publications', async t => {
  const { service, file } = await fixture(t, [adapter('one', async () => ({ status: 'published' })), adapter('two', async () => ({ status: 'published' }))]);
  const first = await service.create(file, ['one', 'two'], 'publish');
  const reordered = await service.create(file, ['two:main', 'one:main'], 'publish');
  assert.equal(first.id, reordered.id);
});

test('an explicit platform rejection can be retried by resume without replaying confirmed uploads', async t => {
  let uploads = 0;
  let submissions = 0;
  const platform = adapter('one', async context => {
    await context.step('asset.upload', async () => { uploads++; return { id: 'asset' }; });
    return context.step('publish', async () => {
      submissions++;
      if (submissions === 1) throw new CliError('API', 'rejected', { outcome: 'rejected' });
      return { status: 'published' };
    });
  });
  const { service, file } = await fixture(t, [platform]);
  const job = await service.create(file, ['one'], 'publish');
  assert.equal((await service.run(job.id)).targets[0].status, 'rejected');
  assert.equal((await service.run(job.id)).targets[0].status, 'published');
  assert.equal(uploads, 1);
  assert.equal(submissions, 2);
});

test('a process interruption after durable intent is unknown, never a new write', async t => {
  let writes = 0;
  const platform = adapter('one', async () => { writes++; return { status: 'published' }; });
  const { service, home, file } = await fixture(t, [platform]);
  const job = await service.create(file, ['one'], 'publish');
  job.targets[0].status = 'running';
  job.targets[0].steps.publish = { phase: 'running' };
  await writeJson(join(home, 'jobs', job.id, 'job.json'), job);
  assert.equal((await service.run(job.id)).targets[0].status, 'unknown');
  assert.equal(writes, 0);
});

test('draft references survive an uncertain publish and a draft read cannot falsely confirm publication', async t => {
  let submissions = 0;
  const platform = adapter('one', async context => {
    const draft = await context.step('draft.create', async () => ({ kind: 'draft' as const, id: 'draft-id' }));
    await context.remember(draft);
    return context.step('publish', async () => { submissions++; throw new Error('connection lost'); });
  });
  platform.inspect = async (_account, remote) => ({ status: 'draft_saved', remote });
  const { service, file } = await fixture(t, [platform]);
  const job = await service.create(file, ['one'], 'publish');
  await service.run(job.id);
  assert.equal((await service.get(job.id)).targets[0].remote?.id, 'draft-id');
  assert.equal((await service.refresh(job.id)).targets[0].status, 'unknown');
  await service.run(job.id);
  assert.equal(submissions, 1);
});

test('content and image changes invalidate old plans before platform writes', async t => {
  let writes = 0;
  const platform = adapter('one', async () => { writes++; return { status: 'published' }; });
  const { service, file, home } = await fixture(t, [platform]);
  const image = join(home, 'cover.png');
  await writeFile(image, 'first-image');
  await writeFile(file, '# Title\n\n![cover](./cover.png)');
  const job = await service.create(file, ['one'], 'publish');
  await writeFile(image, 'different-image');
  await assert.rejects(service.run(job.id), /图片已改变/);
  await writeFile(file, '# Changed');
  await assert.rejects(service.run(job.id), /源文件已改变/);
  assert.equal(writes, 0);
});

test('account locks isolate platforms but serialize the same account', async t => {
  const { home } = await fixture(t, []);
  const one = new AccountStore(home, 'one');
  const two = new AccountStore(home, 'two');
  await one.lock(async () => {
    await assert.rejects(one.lock(async () => undefined), (error: CliError) => error.code === 'BUSY');
    assert.equal(await two.lock(async () => 42), 42);
  });
  await one.save({ id: 'one-id', name: 'Expected' });
  await assert.rejects(one.verify({ id: 'other-id', name: 'Other' }), (error: CliError) => error.code === 'AUTH');
  assert.throws(() => new AccountStore(home, '../outside'), /名称/);
});

test('job events contain stages rather than article content or credentials', async t => {
  const platform = adapter('one', context => context.step('publish', async () => ({ status: 'published' })));
  const { service, home, file } = await fixture(t, [platform]);
  const job = await service.create(file, ['one'], 'publish');
  await service.run(job.id);
  const events = await readFile(join(home, 'jobs', job.id, 'events.jsonl'), 'utf8');
  assert.ok(!events.includes('Original content'));
  assert.ok(!events.includes('Cookie'));
  assert.deepEqual(events.trim().split('\n').map(line => JSON.parse(line).phase), ['started', 'confirmed']);
});
