import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function cli(arguments_: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--home', home, ...arguments_], {
    encoding: 'utf8', env: { ...process.env, JUEJIN_AUTO_INSTALL_SKILL: '0', WM_AUTO_INSTALL_SKILL: '0' },
  });
}

test('JSON argument errors are one parseable document without help text', () => {
  const home = mkdtempSync(join(tmpdir(), 'juejin-cli-'));
  try {
    const result = cli(['--json', 'hot', '--limit', '101'], home);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INPUT');
    assert.equal(result.stderr.trim().split('\n').length, 1);
  } finally { rmSync(home, { recursive: true }); }
});

test('missing session returns auth error without making a request', () => {
  const home = mkdtempSync(join(tmpdir(), 'juejin-cli-'));
  try {
    const result = cli(['auth', 'status', '--json'], home);
    assert.equal(result.status, 3);
    assert.equal(JSON.parse(result.stderr).error.code, 'AUTH');
  } finally { rmSync(home, { recursive: true }); }
});

test('column dry run validates metadata without a session or remote writes', () => {
  const home = mkdtempSync(join(tmpdir(), 'juejin-cli-'));
  try {
    const result = cli(['column', 'create', '--title', 'CLI 实践', '--intro', '使用 AI 操作技术社区', '--dry-run', '--json'], home);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data, { column_id: '0', title: 'CLI 实践', content: '使用 AI 操作技术社区', cover: '', dry_run: true });
  } finally { rmSync(home, { recursive: true }); }
});
