import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const run = args => JSON.parse(execFileSync(process.execPath, ['dist/wm.js', ...args, '--json'], { encoding: 'utf8', env: { ...process.env, WM_AUTO_INSTALL_SKILL: '0' } })).data;
const platforms = run(['platform', 'list']);
assert.ok(platforms.length > 0);
for (const platform of platforms) assert.ok(platform.capabilities.length > 0);
assert.equal(run(['schema', 'platform', 'exec']).command.name, 'exec');
console.log('PASS wm discovery and capability schemas');
