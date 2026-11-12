import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWmProgram, runWmCli } from '../src/cli/wm-program.js';
import { PlatformRegistry } from '../src/core/registry.js';
import { CliError } from '../src/shared/errors.js';
import { fixture, platformFixture } from './helpers.js';

test('schema describes registered payload contracts and has no platform fields in generic CLI flags', async () => {
  let stdout = '';
  const program = createWmProgram({ streams: { stdout: { write: value => { stdout += value; } }, stderr: { write: () => undefined } } });
  await program.parseAsync(['schema', 'platform', 'exec', '--json'], { from: 'user' });
  const result = JSON.parse(stdout).data;
  assert.equal(result.command.name, 'exec');
  const xhs = result.platforms.find((platform: { id: string }) => platform.id === 'xiaohongshu');
  assert.ok(!xhs.capabilities.some((capability: { id: string }) => capability.id === 'draft.create'));
  const writing = xhs.capabilities.find((capability: { id: string }) => capability.id === 'content.publish');
  assert.equal(writing.input_schema.properties.options.properties.visibility.enum.length, 3);
  assert.equal(writing.acceptance.liveWrite, false);
});

test('the generic CLI calls a custom capability through the same verified account session', async t => {
  const one = platformFixture('one', async () => ({ status: 'published' }));
  const { home, registry } = await fixture(t, [one]);
  const file = join(home, 'input.json'); await writeFile(file, '{}');
  let stdout = '';
  await createWmProgram({ registry, streams: { stdout: { write: value => { stdout += value; } }, stderr: { write: () => undefined } } })
    .parseAsync(['--home', home, 'platform', 'exec', 'one', 'newsletter.metrics', '--input', file, '--json'], { from: 'user' });
  assert.deepEqual(JSON.parse(stdout).data, { total: 0, enabled: false });
  assert.deepEqual(one.counts, { sessions: 1, closes: 1 });
});

test('program instances isolate arguments and schema rejects unknown paths', async () => {
  let one = '', two = '';
  const first = createWmProgram({ streams: { stdout: { write: value => { one += value; } }, stderr: { write: () => undefined } } });
  const second = createWmProgram({ streams: { stdout: { write: value => { two += value; } }, stderr: { write: () => undefined } } });
  await first.parseAsync(['schema', 'auth', '--json'], { from: 'user' });
  assert.equal(second.opts().json, undefined);
  assert.equal(two, ''); assert.equal(JSON.parse(one).data.command.name, 'auth');
  await assert.rejects(second.parseAsync(['schema', 'made-up'], { from: 'user' }), (error: CliError) => error.code === 'INPUT');
});

test('wm JSON argument errors remain one document', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/wm.ts', 'article', 'publish', '--bad', '--json'], {
    encoding: 'utf8', env: { ...process.env, WM_AUTO_INSTALL_SKILL: '0' },
  });
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'INPUT');
});

test('a single capability schema is discoverable offline with input defaults preserved', async () => {
  let output = '';
  await createWmProgram({ streams: { stdout: { write: value => { output += value; } }, stderr: { write: () => undefined } } })
    .parseAsync(['schema', '--platform', 'wechat', '--capability', 'draft.list', '--json'], { from: 'user' });
  const result = JSON.parse(output).data;
  assert.equal(result.platforms.length, 1);
  assert.equal(result.platforms[0].capabilities.length, 1);
  const schema = result.platforms[0].capabilities[0].input_schema;
  assert.equal(schema.properties.limit.default, 20);
  assert.ok(!(schema.required ?? []).includes('limit'));
});

test('the generic plan commands prepare offline and later execute the frozen input', async t => {
  const one = platformFixture('one', async () => ({ status: 'published' }));
  const { home } = await fixture(t, [one]);
  const path = join(home, 'input.json');
  await writeFile(path, JSON.stringify({ body: 'Frozen CLI content' }));
  let stdout = '', stderr = '';
  const streams = { stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: (value: string) => { stderr += value; } } };
  const registry = new PlatformRegistry([one.platform]);
  assert.equal(await runWmCli(['--home', home, 'plan', 'create', 'newsletter.send', '--to', 'one', '--input', path, '--json'], { streams, registry }), 0, stderr);
  const id = JSON.parse(stdout).data.id; assert.equal(one.counts.sessions, 0);
  stdout = ''; await writeFile(path, JSON.stringify({ body: 'Changed input' }));
  assert.equal(await runWmCli(['--home', home, 'plan', 'inspect', id, '--json'], { streams, registry }), 0, stderr);
  assert.equal(JSON.parse(stdout).data.targets[0].prepared.body, 'Frozen CLI content');
  stdout = '';
  assert.equal(await runWmCli(['--home', home, 'plan', 'run', id, '--json'], { streams, registry }), 0, stderr);
  assert.equal(JSON.parse(stdout).data.plan_id, id);
  assert.equal(one.counts.sessions, 1);
});
