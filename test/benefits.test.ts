import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JuejinHttp } from '../src/platform/juejin/http.js';
import { JuejinClient } from '../src/platform/juejin/client.js';
import { supplementTimestamp } from '../src/platform/juejin/checkin-date.js';
import { CliError } from '../src/shared/errors.js';

function services(_home: string, fetch: typeof globalThis.fetch) {
  return { client: new JuejinClient(new JuejinHttp({ cookie: 'sessionid=fabricated', fetch })) };
}
const response = (data: unknown) => Response.json({ err_no: 0, err_msg: 'success', data });

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
