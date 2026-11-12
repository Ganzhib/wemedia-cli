import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JuejinHttp } from '../src/platform/juejin/http.js';
import { JuejinClient } from '../src/platform/juejin/client.js';
import { CliError } from '../src/shared/errors.js';

test('preserves numeric platform IDs above Number.MAX_SAFE_INTEGER', async () => {
  const http = new JuejinHttp({ fetch: async () => new Response('{"err_no":0,"data":{"tag_id":6809640357354012685,"count":12}}') });
  const result = await http.data<{ tag_id: string; count: number }>('/test');
  assert.equal(result.tag_id, '6809640357354012685');
  assert.equal(result.count, 12);
});

test('does not replay writes after network failure or HTTP failure', async () => {
  for (const networkFailure of [true, false]) {
    let calls = 0;
    const http = new JuejinHttp({ fetch: async () => {
      calls++;
      if (networkFailure) throw new TypeError('socket closed');
      return new Response('bad gateway', { status: 502 });
    } });
    await assert.rejects(() => new JuejinClient(http).publish('123'), CliError);
    assert.equal(calls, 1);
  }
});

test('retains business error code without including authentication secrets', async () => {
  const http = new JuejinHttp({ cookie: 'sessionid=secret', fetch: async () => Response.json({ err_no: 1000, err_msg: 'not logged in', data: null }) });
  await assert.rejects(() => http.data('/private'), (error: CliError) => {
    assert.deepEqual(error.details, { path: '/private', err_no: 1000, outcome: 'rejected' });
    assert.ok(!JSON.stringify(error).includes('secret'));
    return true;
  });
});

test('checks nullable data only when a caller needs a result', async () => {
  const http = new JuejinHttp({ fetch: async () => Response.json({ err_no: 0, data: null }) });
  assert.equal((await http.request('/update', {})).data, null);
  await assert.rejects(() => http.data('/detail'), (error: CliError) => error.code === 'PROTOCOL');
});

test('publishes the existing draft into the requested columns using string IDs', async () => {
  let captured: unknown;
  const http = new JuejinHttp({ fetch: async (_url, init) => {
    captured = JSON.parse(init!.body as string);
    return Response.json({ err_no: 0, data: { article_id: '7650000000000000001' } });
  } });
  await new JuejinClient(http).publish('7650000000000000000', ['7650000000000000002']);
  assert.deepEqual(captured, {
    draft_id: '7650000000000000000', sync_to_org: false, column_ids: ['7650000000000000002'], theme_ids: [], encrypted_word_count: 0,
  });
});

test('updates a draft with id instead of draft_id', async () => {
  let captured: Record<string, unknown>;
  const http = new JuejinHttp({ fetch: async (_url, init) => {
    captured = JSON.parse(init!.body as string);
    return Response.json({ err_no: 0, data: null });
  } });
  await new JuejinClient(http).updateDraft('123', { title: 'Title', mark_content: '# Body', brief_content: 'Summary', category_id: '5', tag_ids: ['6'], cover_image: '' });
  assert.equal(captured!.id, '123');
  assert.equal(captured!.draft_id, undefined);
});

test('article detail uses the web preload request that includes Markdown', async () => {
  let body: unknown;
  const http = new JuejinHttp({ fetch: async (_url, init) => {
    body = JSON.parse(init!.body as string);
    return Response.json({ err_no: 0, data: { article_info: { mark_content: '# Article' } } });
  } });
  const article = await new JuejinClient(http).article('123');
  assert.equal(article.article_info.mark_content, '# Article');
  assert.deepEqual(body, { article_id: '123', req_from: 0, client_type: 2608, forbid_count: true, is_pre_load: true });
});

test('column creation and editing share the editor publish endpoint', async () => {
  const requests: { url: string; body: unknown }[] = [];
  const http = new JuejinHttp({ fetch: async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init!.body as string) });
    return Response.json({ err_no: 0, data: '7650000000000000000' });
  } });
  const client = new JuejinClient(http);
  const input = { title: '专栏', content: '专栏介绍', cover: 'https://example.com/cover.png' };
  assert.equal(await client.createColumn(input), '7650000000000000000');
  await client.updateColumn('7650000000000000000', input);
  assert.ok(requests.every(request => request.url.endsWith('/column/publish')));
  assert.deepEqual(requests.map(request => request.body), [{ ...input, column_id: '0' }, { ...input, column_id: '7650000000000000000' }]);
});

test('tag search follows server cursors and reports a repeated cursor', async () => {
  const cursors: string[] = [];
  const http = new JuejinHttp({ fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    cursors.push(body.cursor);
    return Response.json({ err_no: 0, data: [{ tag: { tag_id: body.cursor, tag_name: 'React.js' } }], cursor: 'next', has_more: body.cursor === '0' });
  } });
  assert.equal((await new JuejinClient(http).findTags('react')).length, 2);
  assert.deepEqual(cursors, ['0', 'next']);
  const stuck = new JuejinHttp({ fetch: async () => Response.json({ err_no: 0, data: [], cursor: '0', has_more: true }) });
  await assert.rejects(() => new JuejinClient(stuck).findTags('React'), /游标重复/);
});

test('exact tag resolution stops before requesting later pages', async () => {
  let requests = 0;
  const client = new JuejinClient(new JuejinHttp({ fetch: async () => {
    requests++;
    if (requests > 1) throw new Error('unnecessary page');
    return Response.json({ err_no: 0, data: [{ tag: { tag_id: '123', tag_name: 'TypeScript' } }], cursor: 'next', has_more: true });
  } }));
  assert.equal((await client.findTags('typescript', true))[0]?.tag_id, '123');
  assert.equal(requests, 1);
});
