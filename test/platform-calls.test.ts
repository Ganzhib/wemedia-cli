import { operationResultSchema } from '../src/core/types.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ObjectStore, semanticDigest } from '../src/runtime/objects.js';
import { fixture } from './helpers.js';
import { createJuejinPlatform } from '../src/platform/juejin/adapter.js';
import { SessionStore } from '../src/platform/juejin/session.js';
import { AccountRepository } from '../src/runtime/accounts.js';
import { PublishingService } from '../src/services/publishing.js';
import { PlatformRegistry } from '../src/core/registry.js';
import { definePlatform } from '../src/core/platform.js';
import { writeCapability } from '../src/core/capability.js';
import { z } from 'zod';

test('the real Juejin driver verifies once, creates the actual draft request and publishes to selected columns', async t => {
  const { home } = await fixture(t, []);
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const platform = createJuejinPlatform({ fetch: async (url, init) => {
    assert.match(new Headers(init!.headers).get('cookie')!, /sessionid=fabricated/);
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path, body });
    let data: unknown;
    if (path.endsWith('/user/get')) data = { user_id: 'juejin-id', user_name: 'Creator' };
    else if (path.endsWith('query_category_briefs')) data = [{ category_id: '1', category_name: '前端', category_url: 'frontend' }];
    else if (path.endsWith('article_draft/create')) data = { id: 'draft-1' };
    else if (path.endsWith('article/publish')) data = { article_id: 'article-1' };
    else if (path.endsWith('article_draft/list_by_user')) data = [{ id: 'draft-1', title: 'A title' }];
    else if (path.endsWith('article/list_by_user')) data = [{ article_info: { article_id: 'article-1', title: 'A title' } }];
    else if (path.endsWith('query_tag_list')) data = [{ tag: { tag_id: 'tag-1', tag_name: 'TypeScript' } }];
    else if (path.endsWith('column/author_center_list')) data = [{ column: { column_id: 'column-1' }, column_version: { title: 'Column' } }];
    else throw new Error('Unexpected request: ' + path);
    return Response.json({ err_no: 0, data });
  } });
  const accounts = new AccountRepository(home);
  await accounts.login('juejin', 'main', async directory => {
    await new SessionStore(directory).save([{ name: 'sessionid', value: 'fabricated', domain: '.juejin.cn', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    return { id: 'juejin-id', name: 'Creator' };
  });
  const file = join(home, 'article.md');
  await writeFile(file, '# A title\n\nA complete article about real design decisions.');
  const service = new PublishingService(home, new PlatformRegistry([platform]));
  const options = { category: '1', tags: ['2'], columns: ['column-1'], brief: '这是一段用于验证统一能力调用的真实内容摘要，确认账号只验证一次，并确保草稿与专栏发布通过相同会话执行，返回的远端标识用于后续结果核对。' };
  const job = await service.create('content.publish', { file, options }, ['juejin']);
  const result = await service.run(job.id);
  assert.equal(result.targets[0].status, 'submitted');
  assert.equal(result.targets[0].remote?.id, 'article-1');
  assert.equal(requests.filter(request => request.path.endsWith('/user/get')).length, 1);
  const creation = requests.find(request => request.path.endsWith('article_draft/create'))!;
  assert.equal(creation.body.title, 'A title'); assert.match(String(creation.body.mark_content), /complete article/);
  assert.deepEqual(requests.find(request => request.path.endsWith('article/publish'))!.body.column_ids, ['column-1']);
  await service.run(job.id);
  assert.equal(requests.filter(request => request.path.endsWith('article/publish')).length, 1);
  const list = await service.invoke('juejin', 'main', 'draft.list', { limit: 3 });
  assert.deepEqual(list.value, { items: [{ resource: { kind: 'draft', id: 'draft-1' }, title: 'A title' }] });
  assert.deepEqual((await service.invoke('juejin', 'main', 'article.list', { limit: 2 })).value, { items: [{ resource: { kind: 'article', id: 'article-1', url: 'https://juejin.cn/post/article-1' }, title: 'A title' }] });
  assert.deepEqual((await service.invoke('juejin', 'main', 'juejin.category.list', {})).value, { items: [{ resource: { kind: 'category', id: '1' }, title: '前端' }] });
  assert.deepEqual((await service.invoke('juejin', 'main', 'juejin.tag.search', { keyword: 'TypeScript' })).value, { items: [{ resource: { kind: 'tag', id: 'tag-1' }, title: 'TypeScript' }] });
  assert.equal((await service.invoke('juejin', 'main', 'juejin.column.list', { limit: 2 })).effect, 'read');
  await writeFile(join(home, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVJkAAAAASUVORK5CYII=', 'base64'));
  await writeFile(file, '# Cache failure\n\n![image](./image.png)');
  const artifact = await new ObjectStore(home).put(await readFile(join(home, 'image.png')), 'image/png', '.png');
  const key = semanticDigest({ identity: await accounts.resolve('juejin'), artifact, purpose: 'article-image', protocol: 'imagex-v1' });
  await mkdir(join(home, 'cache', 'uploads'), { recursive: true });
  await writeFile(join(home, 'cache', 'uploads', key + '.json'), 'invalid JSON');
  const cacheFailure = await service.invoke('juejin', 'main', 'draft.create', { file, options });
  if (cacheFailure.effect === 'remote-write') assert.equal(cacheFailure.value.targets[0].status, 'rejected');
  assert.equal(requests.filter(request => request.path.endsWith('gen_token')).length, 0);
  assert.equal(requests.filter(request => request.path.endsWith('article_draft/create')).length, 1);

});

test('a binary-only platform and custom resource kind require no changes to the executor', async t => {
  const { home } = await fixture(t, []);
  const schema = z.strictObject({ mediaType: z.literal('video/mp4'), bytes: z.array(z.int().min(0).max(255)).min(1) });
  const platform = definePlatform<{ profile: { id: string; name: string }; directory: string }>({
    id: 'video', name: 'Video', driver: { id: 'video.test', version: '2' },
    login: async () => ({ id: 'video-id', name: 'Video' }),
    withSession: (account, action) => action({ profile: { id: 'video-id', name: 'Video' }, directory: account.directory }),
    capabilities: [writeCapability<{ profile: { id: string; name: string }; directory: string }>()({
      id: 'clip.upload', description: 'Upload video', acceptance: { offline: true, liveRead: false, liveWrite: false },
      input: schema, prepared: schema, output: operationResultSchema.extend({ status: z.literal('completed'), data: z.object({ uploadedBytes: z.number() }) }), successStates: ['completed'], prepare: async input => input, preflight: async () => undefined,
      execute: async ({ session }, input) => {
        await writeFile(join(session.directory, 'sent.bin'), Buffer.from(input.bytes));
        return { status: 'completed', remote: { kind: 'video-clip', id: 'clip-1' }, data: { uploadedBytes: input.bytes.length } };
      },
    })],
  });
  const accounts = new AccountRepository(home);
  const binding = await accounts.login('video', 'main', directory => platform.login(directory));
  const service = new PublishingService(home, new PlatformRegistry([platform]));
  const result = await service.invoke('video', 'main', 'clip.upload', { mediaType: 'video/mp4', bytes: [0, 1, 2, 255] });
  assert.equal(result.effect, 'remote-write');
  if (result.effect === 'remote-write') {
    assert.equal(result.value.targets[0].remote?.kind, 'video-clip');
    assert.equal(result.value.targets[0].status, 'completed');
    assert.deepEqual(result.value.targets[0].steps['capability.execute'].value.data, { uploadedBytes: 4 });
  }
  await accounts.use(binding.identity, async account => assert.deepEqual(await readFile(join(account.directory, 'sent.bin')), Buffer.from([0, 1, 2, 255])));
});

test('Juejin updates and publishes the original draft with conflict checks, normalized metadata and revision lineage', async t => {
  const { home } = await fixture(t, []); let creates = 0, updates = 0, publishes = 0;
  const original = { id: '101', title: 'Original', mark_content: 'Old body', brief_content: '这是一段用于验证草稿更新的原始摘要，保留既有分类、标签、封面及文章身份，在修改正文后仍然更新同一份远端草稿，不通过新建同标题文章来模拟更新。', category_id: '1', tag_ids: ['3', '2'], cover_image: 'https://cdn.example/old.png', edit_type: 10, html_content: '' };
  let remote = { ...original };
  const platform = createJuejinPlatform({ fetch: async (url, init) => {
    const path = new URL(String(url)).pathname; const body = init?.body ? JSON.parse(String(init.body)) : {};
    let data;
    if (path.endsWith('/user/get')) data = { user_id: 'id', user_name: 'Creator' };
    else if (path.endsWith('article_draft/detail')) data = { article_draft: remote };
    else if (path.endsWith('article_draft/update')) { updates++; assert.equal(body.id, '101'); remote = { ...remote, ...body }; data = remote; }
    else if (path.endsWith('article_draft/create')) { creates++; data = { id: 'duplicate' }; }
    else if (path.endsWith('article/publish')) { publishes++; assert.equal(body.draft_id, '101'); data = { article_id: '202' }; }
    else throw new Error('Unexpected ' + path);
    return Response.json({ err_no: 0, data });
  } });
  await new AccountRepository(home).login('juejin', 'main', async directory => {
    await new SessionStore(directory).save([{ name: 'sessionid', value: 'fabricated', domain: '.juejin.cn', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }]); return { id: 'id', name: 'Creator' };
  });
  const service = new PublishingService(home, new PlatformRegistry([platform])); const file = join(home, 'update.md');
  await writeFile(file, '# Updated\n\nUpdated complete body.');
  const base = (await service.invoke('juejin', 'main', 'resource.get', { resource: { kind: 'draft', id: '101' } })).value;
  const updated = await service.invoke('juejin', 'main', 'draft.update', { file, base });
  assert.equal(updated.effect, 'remote-write');
  if (updated.effect === 'remote-write') {
    assert.equal(updated.value.targets[0].status, 'draft_saved', updated.value.targets[0].message);
    assert.equal(updated.value.targets[0].remote?.id, '101');
  }
  assert.equal(creates, 0); assert.equal(updates, 1); assert.deepEqual(remote.tag_ids, ['2', '3']); assert.equal(remote.cover_image, original.cover_image);
  const stale = await service.create('draft.update', { file, options: { title: 'Another' }, base }, ['juejin']);
  const conflict = await service.run(stale.id); assert.equal(conflict.targets[0].requiredAction, 'review_remote_changes');
  assert.equal(conflict.targets[0].failure?.code, 'CONFLICT'); assert.equal(updates, 1);
  const current = (await service.invoke('juejin', 'main', 'resource.get', { resource: { kind: 'draft', id: '101' } })).value;
  const published = await service.invoke('juejin', 'main', 'draft.publish', { base: current, columns: ['7'] });
  if (published.effect === 'remote-write') assert.equal(published.value.targets[0].status, 'submitted');
  assert.equal(creates, 0); assert.equal(publishes, 1);
  const lineage = await service.publications.list(); assert.equal(lineage.length, 1); assert.equal(lineage[0].revisions.length, 2);
});
