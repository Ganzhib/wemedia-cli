import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function cli(arguments_: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/wm.ts', '--home', home, ...arguments_], {
    encoding: 'utf8', env: { ...process.env, WM_AUTO_INSTALL_SKILL: '0' },
  });
}

test('JSON argument errors are one parseable document without help text', () => {
  const home = mkdtempSync(join(tmpdir(), 'juejin-cli-'));
  try {
    const result = cli(['--json', 'platform', 'exec', 'missing', 'unknown'], home);
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
