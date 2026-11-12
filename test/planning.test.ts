import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { fixture, platformFixture } from './helpers.js';
import { PreparationContext } from '../src/content/preparation.js';
import { ObjectStore } from '../src/runtime/objects.js';
import { createXiaohongshuPlatform } from '../src/platform/xiaohongshu/adapter.js';
import { createJuejinPlatform } from '../src/platform/juejin/adapter.js';
import { PlatformRegistry } from '../src/core/registry.js';
import { PlanningService } from '../src/services/planning.js';
import { PublishingService } from '../src/services/publishing.js';
import { writeCapability } from '../src/core/capability.js';
import { definePlatform } from '../src/core/platform.js';
import { artifactSchema } from '../src/core/content.js';
import { operationResultSchema } from '../src/core/types.js';
import { SessionStore } from '../src/platform/juejin/session.js';
import { AccountRepository } from '../src/runtime/accounts.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVJkAAAAASUVORK5CYII=', 'base64');
async function article(home: string, directory: string) {
  const path = join(home, directory); await mkdir(path);
  await writeFile(join(path, 'cover.png'), png);
  await writeFile(join(path, 'article.md'), '# 原稿\n\n原始正文。\n\n![封面](./cover.png)');
  return join(path, 'article.md');
}

test('objects publish complete bytes atomically and detect damaged snapshots', async t => {
  const { home } = await fixture(t, []);
  const objects = new ObjectStore(home);
  const results = await Promise.all(Array.from({ length: 8 }, () => objects.put(png, 'image/png', '.png')));
  assert.deepEqual(await objects.read(results[0]), png);
  assert.ok(results.every(result => result.digest === results[0].digest));
  await writeFile(objects.path(results[0]), 'corrupt');
  await assert.rejects(objects.verify(results[0]), /损坏/);
});

test('moving source directories or wm home keeps plan identity; changed bytes or outputs create new input', async t => {
  const { home, accounts } = await fixture(t, []);
  const file = await article(home, 'first');
  const moved = join(home, 'second'); await cp(join(home, 'first'), moved, { recursive: true });
  await accounts.login('xiaohongshu', 'main', async () => ({ id: 'id', name: 'Creator' }));
  const registry = new PlatformRegistry([createXiaohongshuPlatform()]);
  const planning = new PlanningService(home, registry);
  const first = await planning.create('content.publish', { file }, ['xiaohongshu']);
  assert.equal((await planning.create('content.publish', { file: join(moved, 'article.md') }, ['xiaohongshu'])).id, first.id);
  const variant = await planning.variant(first.targets[0]);
  assert.ok(!JSON.stringify(variant.prepared).includes(home));
  await writeFile(join(moved, 'cover.png'), Buffer.concat([png, Buffer.from('different')]));
  assert.notEqual((await planning.create('content.publish', { file: join(moved, 'article.md') }, ['xiaohongshu'])).id, first.id);
  assert.notEqual((await planning.create('content.publish', { file, options: { content: '平台版本变动' } }, ['xiaohongshu'])).id, first.id);
  const relocated = home + '-relocated'; t.after(() => rm(relocated, { recursive: true, force: true })); await cp(home, relocated, { recursive: true });
  const movedPlanning = new PlanningService(relocated, registry);
  assert.deepEqual((await movedPlanning.variant(first.targets[0])).prepared, variant.prepared);
  await rm(join(home, 'first'), { recursive: true });
  assert.deepEqual((await planning.variant(first.targets[0])).prepared, variant.prepared);
});

test('a preparation batch captures a shared file once even when a later renderer changes its source', async t => {
  const { home } = await fixture(t, []);
  const file = join(home, 'input.bin'); await writeFile(file, 'original');
  const root = new PreparationContext(home);
  const first = await root.fork().capture(file, 'application/octet-stream');
  await writeFile(file, 'changed');
  const second = await root.fork().capture(file, 'application/octet-stream');
  assert.deepEqual(second, first);
  assert.equal((await root.objects.read(second)).toString(), 'original');
});

test('binary-only imports execute from a saved plan after original files disappear', async t => {
  const { home, accounts } = await fixture(t, []);
  const file = join(home, 'clip.bin'); await writeFile(file, Buffer.from([0, 255, 10]));
  let uploaded: Buffer | undefined;
  const platform = definePlatform({ id: 'binary', name: 'Binary', driver: { id: 'binary.test', version: '1' },
    login: async () => ({ id: 'id', name: 'Binary' }),
    withSession: (_account, action) => action({ profile: { id: 'id', name: 'Binary' } }),
    capabilities: [writeCapability<{ profile: { id: string; name: string } }>()({
      id: 'clip.upload', description: 'Binary upload', acceptance: { offline: true, liveRead: false, liveWrite: false },
      input: z.object({ file: z.string() }), prepared: z.object({ clip: artifactSchema }), output: operationResultSchema, successStates: ['completed'],
      prepare: async (input, context) => { const clip = await context.capture(input.file, 'video/example'); context.source(clip, 'binary', null); return { clip }; },
      preflight: async () => undefined,
      execute: async (context, input) => { uploaded = await context.artifacts.read(input.clip); return { status: 'completed' }; },
    })],
  });
  await accounts.login('binary', 'main', directory => platform.login(directory));
  const service = new PublishingService(home, new PlatformRegistry([platform]));
  const plan = await service.planning.create('clip.upload', { file }, ['binary']);
  await rm(file);
  const job = await service.start(plan.id);
  assert.equal((await service.run(job.id)).targets[0].status, 'completed');
  assert.deepEqual(uploaded, Buffer.from([0, 255, 10]));
});

test('renderer upgrades with identical output do not create a new copy; the saved driver stays pinned', async t => {
  const one = platformFixture('one', async () => ({ status: 'published' }));
  const { service } = await fixture(t, [one]);
  const first = await service.planning.create('newsletter.send', { body: 'same' }, ['one']);
  one.platform.driver.version = 'next';
  const next = await service.planning.create('newsletter.send', { body: 'same' }, ['one']);
  assert.equal(next.id, first.id); assert.equal(next.targets[0].driver.version, '2');
  await assert.rejects(service.run((await service.start(first.id)).id), /版本/);
});

test('the real Juejin uploader reads frozen bytes even when authentication modifies the original image', async t => {
  const { home } = await fixture(t, []);
  const file = await article(home, 'source'); let uploaded: Uint8Array | undefined; let requestBody: any;
  const token = { AccessKeyId: 'fixture', SecretAccessKey: 'fixture', SessionToken: 'fixture' };
  const platform = createJuejinPlatform({ fetch: async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.searchParams.get('Action') === 'ApplyImageUpload') return Response.json({ Result: { UploadAddress: { SessionKey: 'opaque', UploadHosts: ['upload.snssdk.com'], StoreInfos: [{ StoreUri: 'image/path', Auth: 'upload' }] } } });
    if (parsed.searchParams.get('Action') === 'CommitImageUpload') return Response.json({ Result: { Results: [{ UriStatus: 2000 }] } });
    if (parsed.hostname === 'upload.snssdk.com') { uploaded = init!.body as Uint8Array; return new Response('{}'); }
    let data: unknown;
    if (parsed.pathname.endsWith('/user/get')) { await writeFile(join(home, 'source', 'cover.png'), 'changed during auth'); data = { user_id: 'id', user_name: 'Creator' }; }
    else if (parsed.pathname.endsWith('query_category_briefs')) data = [{ category_id: '1', category_name: '前端', category_url: 'frontend' }];
    else if (parsed.pathname.endsWith('gen_token')) data = { token };
    else if (parsed.pathname.endsWith('get_img_url')) data = { main_url: 'https://cdn.example/frozen.png' };
    else if (parsed.pathname.endsWith('article_draft/create')) { requestBody = JSON.parse(String(init!.body)); data = { id: 'saved' }; }
    else throw new Error('Unexpected request: ' + parsed.pathname);
    return Response.json({ err_no: 0, data });
  } });
  await new AccountRepository(home).login('juejin', 'main', async directory => {
    await new SessionStore(directory).save([{ name: 'sessionid', value: 'fabricated', domain: '.juejin.cn', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }]); return { id: 'id', name: 'Creator' };
  });
  const service = new PublishingService(home, new PlatformRegistry([platform]));
  const plan = await service.planning.create('draft.create', { file, options: { brief: '这是一段用于验证图像快照及实际上传路径的摘要，认证期间源文件发生变化，上传器仍应使用已冻结的内容而不是重新读取作者正在编辑的原始图片。', category: '1', tags: ['2'] } }, ['juejin']);
  await rm(file);
  const result = await service.run((await service.start(plan.id)).id);
  assert.equal(result.targets[0].status, 'draft_saved', result.targets[0].message);
  assert.deepEqual(Buffer.from(uploaded!), png);
  assert.match(requestBody.mark_content, /https:\/\/cdn.example\/frozen.png/);
  assert.ok(!requestBody.mark_content.includes(home));
});

test('corrupted frozen assets and manifests stop every target before any session opens', async t => {
  const { home, accounts } = await fixture(t, []);
  const file = await article(home, 'input');
  const platform = createXiaohongshuPlatform();
  await accounts.login('xiaohongshu', 'main', async () => ({ id: 'id', name: 'Creator' }));
  const service = new PublishingService(home, new PlatformRegistry([platform]));
  const plan = await service.planning.create('content.publish', { file }, ['xiaohongshu']);
  const variant = await service.planning.variant(plan.targets[0]);
  const image = variant.variant.artifacts.find(artifact => artifact.mediaType === 'image/png')!;
  await writeFile(service.planning.objects.path(image), 'damaged');
  await assert.rejects(service.run((await service.start(plan.id)).id), /损坏/);
  await writeFile(join(home, 'plans', plan.id + '.json'), JSON.stringify({ ...plan, targets: [] }));
  await assert.rejects(service.planning.get(plan.id), /损坏/);
});

test('image upload restrictions are platform-owned and run before creating a plan', async t => {
  const { home } = await fixture(t, []);
  const file = await article(home, 'input'); await writeFile(join(home, 'input', 'cover.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
  const planning = new PlanningService(home, new PlatformRegistry([createJuejinPlatform(), createXiaohongshuPlatform()]));
  await assert.rejects(planning.prepare('draft.create', { file, options: { category: '1', tags: ['2'], brief: '这是一段用于验证各平台图片限制独立维护的完整摘要，图片快照层不应继承掘金的大小限制，并且不合法的掘金图片需要在建立计划之前被拒绝。' } }, ['juejin']), /5 MiB/);
  assert.equal((await planning.prepare('content.publish', { file, options: { content: '图文正文' } }, ['xiaohongshu'])).length, 1);
});
