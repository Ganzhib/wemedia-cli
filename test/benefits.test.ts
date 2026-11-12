import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JuejinHttp } from '../src/platform/juejin/http.js';
import { JuejinClient } from '../src/platform/juejin/client.js';
import { ImageUploader } from '../src/platform/juejin/imagex.js';
import { SessionStore } from '../src/platform/juejin/session.js';
import { DraftService } from '../src/platform/juejin/draft-service.js';
import { WritingService } from '../src/platform/juejin/writing-service.js';
import { supplementTimestamp } from '../src/platform/juejin/checkin-date.js';
import { createProgram } from '../src/cli/program.js';
import { CliError } from '../src/shared/errors.js';

function services(home: string, fetch: typeof globalThis.fetch) {
  const client = new JuejinClient(new JuejinHttp({ cookie: 'sessionid=fabricated', fetch }));
  const session = new SessionStore(home);
  const uploader = new ImageUploader(client.http);
  return { client, session, uploader, writing: new WritingService(client, uploader, session, new DraftService(client, uploader)) };
}
const response = (data: unknown) => Response.json({ err_no: 0, err_msg: 'success', data });
async function receipts(home: string) {
  return (await readFile(join(home, 'operations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

test('growth reads use the current paths and retain false and zero results', async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = services('unused', async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, method: init!.method!, body: init!.body === undefined ? undefined : JSON.parse(init!.body as string) });
    return response(path.endsWith('get_today_status') ? false : 0);
  }).client;
  assert.equal(await client.checkInStatus(), false);
  assert.equal(await client.points(), 0);
  assert.equal(await client.supplementCards(), 0);
  await client.checkInCalendar();
  await client.checkInCalendar(true);
  await client.checkInCounts();
  await client.checkInRules();
  await client.lotteryRules();
  assert.deepEqual(requests.map(request => request.path), [
    '/growth_api/v1/get_today_status', '/growth_api/v1/get_cur_point', '/growth_api/v1/get_cur_supp',
    '/growth_api/v1/get_by_month', '/growth_api/v1/get_by_near', '/growth_api/v1/get_counts',
    '/growth_api/v1/get_rules_text', '/growth_api/v1/lottery_config/rules_text',
  ]);
  assert.ok(requests.every(request => request.method === 'GET' && request.body === undefined));
});

test('growth writes send exact bodies without replaying on a network error', async () => {
  const requests: { path: string; body: unknown }[] = [];
  const client = services('unused', async (url, init) => {
    assert.equal(init!.method, 'POST');
    requests.push({ path: new URL(String(url)).pathname, body: JSON.parse(init!.body as string) });
    return response({});
  }).client;
  await client.checkIn(); await client.supplementPreview(123); await client.supplementCheckIn(123);
  await client.lotteryDraw(1); await client.lotteryDraw(10); await client.lotteryDip('7700000000000000001'); await client.lotteryLuckyDraw();
  assert.deepEqual(requests, [
    { path: '/growth_api/v1/check_in', body: {} },
    { path: '/growth_api/v1/get_by_supp', body: { date: 123 } },
    { path: '/growth_api/v1/check_in_supp', body: { date: 123 } },
    { path: '/growth_api/v1/lottery/draw', body: {} },
    { path: '/growth_api/v1/lottery/ten_draw', body: {} },
    { path: '/growth_api/v1/lottery_lucky/dip_lucky', body: { lottery_history_id: '7700000000000000001' } },
    { path: '/growth_api/v1/lottery_lucky/lucky_draw', body: {} },
  ]);
});

test('lottery history projects prize fields and omits fabricated delivery contacts', async () => {
  const client = services('unused', async (_url, init) => {
    assert.deepEqual(JSON.parse(init!.body as string), { page_no: 2, got_channel: '1' });
    return new Response('{"err_no":0,"data":{"count":1,"lottery_histories":[{"history_id":7700000000000000001,"ctime":123,"lottery_id":"9","lottery_name":"示例奖品","lottery_type":4,"lottery_image":"https://example.com/prize.png","lottery_count":1,"receive_status":1,"receive_name":"Example","receive_phone":"00000000000","receive_address":"Fabricated address"}]}}');
  }).client;
  const history = await client.lotteryHistory(2);
  assert.equal(history.items[0]!.history_id, '7700000000000000001');
  assert.equal(JSON.stringify(history).includes('receive_phone'), false);
  assert.equal(JSON.stringify(history).includes('Fabricated'), false);
});

test('supplement dates use Beijing days, validate dates and include exactly the previous 30 days', () => {
  const now = new Date('2026-03-01T16:30:00Z'); // March 2 in Beijing, independent of the machine timezone.
  assert.equal(supplementTimestamp('2026-01-31', now), Date.parse('2026-01-31T00:00:00+08:00') / 1000);
  assert.equal(supplementTimestamp('2026-03-01', now), Date.parse('2026-03-01T00:00:00+08:00') / 1000);
  for (const date of ['2026-03-02', '2026-03-03', '2026-01-30', '2026-02-30', '2026-3-1', 'not a date']) {
    assert.throws(() => supplementTimestamp(date, now), CliError);
  }
});

test('already checked-in and dry-run paths do not send a write or create receipts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-benefits-'));
  try {
    let calls = 0;
    const service = services(home, async (url, init) => {
      calls++;
      assert.ok(String(url).endsWith('/get_today_status'));
      assert.equal(init!.method, 'GET');
      return response(true);
    }).writing;
    assert.equal((await service.checkIn()).status, 'already_checked_in');
    assert.equal((await service.checkIn({ dryRun: true })).dry_run, true);
    assert.equal(calls, 2);
    await assert.rejects(readFile(join(home, 'operations.jsonl')), { code: 'ENOENT' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('check-in holds the account lock for read and write and journals one result', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-benefits-'));
  try {
    const requests: string[] = [];
    const service = services(home, async (url) => {
      await readFile(join(home, 'write.lock'));
      requests.push(new URL(String(url)).pathname);
      return response(String(url).endsWith('get_today_status') ? false : { incr_point: 1, sum_point: 123 });
    }).writing;
    assert.equal((await service.checkIn()).status, 'checked_in');
    assert.deepEqual(requests, ['/growth_api/v1/get_today_status', '/growth_api/v1/check_in']);
    assert.deepEqual((await receipts(home)).map(entry => entry.phase), ['started', 'succeeded']);
    await assert.rejects(readFile(join(home, 'write.lock')), { code: 'ENOENT' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an uncertain check-in writes one failure receipt and releases its lock without replay', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-benefits-'));
  try {
    let writes = 0;
    const service = services(home, async url => {
      if (String(url).endsWith('get_today_status')) return response(false);
      writes++; throw new Error('connection lost after request');
    }).writing;
    await assert.rejects(service.checkIn(), (error: CliError) => error.code === 'NETWORK' && typeof error.details?.operation_id === 'string');
    assert.equal(writes, 1);
    assert.deepEqual((await receipts(home)).map(entry => entry.phase), ['started', 'failed_or_unknown']);
    await assert.rejects(readFile(join(home, 'write.lock')), { code: 'ENOENT' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('concurrent check-ins cannot both enter the account write workflow', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-benefits-'));
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  try {
    let writes = 0;
    const service = services(home, async url => {
      if (String(url).endsWith('get_today_status')) { entered(); await blocked; return response(false); }
      writes++; return response({ incr_point: 1, sum_point: 5 });
    }).writing;
    const first = service.checkIn(); await ready;
    await assert.rejects(service.checkIn(), (error: CliError) => error.code === 'BUSY');
    release(); await first;
    assert.equal(writes, 1);
  } finally { release(); await rm(home, { recursive: true, force: true }); }
});

test('supplement previews never consume cards and a rejected preview prevents a write', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-benefits-'));
  const yesterday = new Date(Date.now() - 86_400_000);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(yesterday);
  try {
    let writes = 0;
    let rejected = false;
    const service = services(home, async url => {
      if (String(url).endsWith('get_by_supp')) {
        if (rejected) return Response.json({ err_no: 1001, err_msg: 'No card', data: null });
        return response({ incr_point: 1 });
      }
      writes++; return response({ incr_point: 1 });
    }).writing;
    assert.equal((await service.supplementCheckIn(date, { dryRun: true })).dry_run, true);
    assert.equal(writes, 0);
    rejected = true;
    await assert.rejects(service.supplementCheckIn(date), CliError);
    assert.equal(writes, 0);
    await assert.rejects(readFile(join(home, 'operations.jsonl')), { code: 'ENOENT' });
    rejected = false;
    assert.equal((await service.supplementCheckIn(date)).status, 'supplemented');
    assert.equal(writes, 1);
    assert.equal((await receipts(home))[1].operation, 'checkin.supplement');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('lottery requires spending consent and uses platform pricing for single and ten-draw previews', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-benefits-'));
  try {
    let requests = 0, draws = 0;
    const service = services(home, async url => {
      requests++;
      if (String(url).endsWith('lottery_config/get')) return response({ free_count: 1, point_cost: 200, lottery: [] });
      if (String(url).endsWith('get_cur_point')) return response(2500);
      draws++; return response({ lottery: { lottery_name: '示例矿石' } });
    }).writing;
    await assert.rejects(service.drawLottery({ count: 1 }), /allow-spend/);
    assert.equal(requests, 0);
    assert.equal((await service.drawLottery({ count: 1, dryRun: true })).estimated_point_cost, 0);
    assert.equal((await service.drawLottery({ count: 10, dryRun: true })).estimated_point_cost, 2000);
    assert.equal(draws, 0);
    assert.equal((await service.drawLottery({ count: 10, allowSpend: true })).status, 'drawn');
    assert.equal(draws, 1);
    assert.deepEqual((await receipts(home)).map(entry => entry.phase), ['started', 'succeeded']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('growth schema is discoverable without authentication and CLI actions use their injected service runner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-benefits-'));
  try {
    let output = '';
    const streams = { stdout: { write: (value: string) => { output += value; } }, stderr: { write: () => {} } };
    const program = createProgram({ streams, services: async () => { throw new Error('schema must not connect'); } });
    await program.parseAsync(['schema', 'checkin', 'schedule', '--json'], { from: 'user' });
    assert.deepEqual(JSON.parse(output).data.command.commands.map((command: { name: string }) => command.name), ['enable', 'status', 'disable']);
    output = '';
    const fake = services(home, async url => response(String(url).endsWith('get_today_status') ? true : {}));
    await createProgram({ streams, growth: async (_session, action) => action(fake) })
      .parseAsync(['checkin', 'run', '--json'], { from: 'user' });
    assert.equal(JSON.parse(output).data.status, 'already_checked_in');
  } finally { await rm(home, { recursive: true, force: true }); }
});
