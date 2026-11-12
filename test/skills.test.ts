import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkill, skillStatus } from '../src/runtime/skills.js';
import { VERSION, PACKAGE_ROOT } from '../src/package.js';

test('installs the complete wm Skill once and leaves matching installations untouched', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wm-skill-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = join(home, 'wm');
  assert.equal((await skillStatus(target)).state, 'missing');
  await installSkill(target);
  const receipt = await readFile(join(target, '.wm-install.json'), 'utf8');
  for (const relative of ['SKILL.md', 'references/scenarios.md']) {
    assert.deepEqual(await readFile(join(target, relative)), await readFile(join(PACKAGE_ROOT, 'skills/wm', relative)));
  }
  await installSkill(target);
  assert.equal(await readFile(join(target, '.wm-install.json'), 'utf8'), receipt);
  assert.equal((await skillStatus(target)).version, VERSION);
});

test('keeps user-edited Skills and reports the conflict', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wm-skill-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = join(home, 'wm');
  await installSkill(target);
  await writeFile(join(target, 'SKILL.md'), 'My instructions');
  assert.equal((await skillStatus(target)).state, 'modified');
  await assert.rejects(() => installSkill(target), /已有自定义 Skill/);
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'My instructions');
});

test('does not take over a same-named skill created outside this package', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wm-skill-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = join(home, 'wm');
  await mkdir(target);
  await writeFile(join(target, 'SKILL.md'), 'Existing skill');
  await assert.rejects(() => installSkill(target), /已有自定义 Skill/);
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'Existing skill');
});

test('installation preserves unrelated files and independently installed sibling Skills', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wm-skill-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const name of ['wemedia-cli', 'juejin-cli', 'drawio-skill']) {
    await mkdir(join(home, name));
    await writeFile(join(home, name, 'SKILL.md'), 'custom ' + name);
  }
  const target = join(home, 'wm');
  await installSkill(target);
  await writeFile(join(target, 'my-notes.md'), 'keep my notes');
  await installSkill(target);
  assert.equal(await readFile(join(target, 'my-notes.md'), 'utf8'), 'keep my notes');
  for (const name of ['wemedia-cli', 'juejin-cli', 'drawio-skill']) {
    assert.equal(await readFile(join(home, name, 'SKILL.md'), 'utf8'), 'custom ' + name);
  }
});
