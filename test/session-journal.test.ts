import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, parseCookies } from '../src/platform/juejin/session.js';
import { CliError } from '../src/shared/errors.js';

const imported = JSON.stringify([
  { name: 'sessionid', value: 'private', domain: '.juejin.cn', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
  { name: 'unrelated', value: 'other', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
]);

test('imports only platform cookies and rejects expired authentication', () => {
  assert.equal(parseCookies(imported).length, 1);
  assert.throws(() => parseCookies(JSON.stringify({ cookies: JSON.parse(imported) })), (error: CliError) => error.code === 'INPUT');
  assert.throws(() => parseCookies(JSON.stringify([{ ...JSON.parse(imported)[0], expires: 1 }])), /未找到有效/);
  assert.throws(() => parseCookies(JSON.stringify([{ ...JSON.parse(imported)[0], value: 'x\r\nInjected: x' }])), /非法字符/);
});

test('stores platform credentials privately', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wm-session-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new SessionStore(home);
  await store.save(parseCookies(imported));
  assert.equal((await store.load())[0].value, 'private');
  if (process.platform !== 'win32') assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  await store.clear();
  await assert.rejects(store.load(), (error: CliError) => error.code === 'AUTH');
});
