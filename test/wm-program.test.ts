import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createWmProgram } from '../src/cli/wm-program.js';

test('wm schema exposes the actual multi-platform command tree without authentication', async () => {
  let stdout = '';
  const program = createWmProgram({ streams: { stdout: { write: value => { stdout += value; } }, stderr: { write: () => undefined } } });
  await program.parseAsync(['schema', 'article', 'publish', '--json'], { from: 'user' });
  const schema = JSON.parse(stdout).data.command;
  assert.equal(schema.name, 'publish');
  assert.ok(schema.options.some((option: { flags: string }) => option.flags === '--to <targets>'));
  assert.ok(schema.options.some((option: { flags: string }) => option.flags === '--dry-run'));
});

test('platform capabilities derive from real handlers rather than a second capability list', async () => {
  let stdout = '';
  const program = createWmProgram({ streams: { stdout: { write: value => { stdout += value; } }, stderr: { write: () => undefined } } });
  await program.parseAsync(['platform', 'list', '--json'], { from: 'user' });
  const platforms = JSON.parse(stdout).data;
  assert.deepEqual(platforms.map((platform: { id: string }) => platform.id), ['juejin', 'xiaohongshu', 'wechat']);
  assert.deepEqual(platforms.find((platform: { id: string }) => platform.id === 'xiaohongshu').operations.map((operation: { id: string }) => operation.id), ['publish']);
});

test('wm JSON argument failures stay one document even when --json follows the bad flag', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/wm.ts', 'article', 'publish', '--bad', '--json'], {
    encoding: 'utf8', env: { ...process.env, WM_AUTO_INSTALL_SKILL: '0' },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'INPUT');
});
