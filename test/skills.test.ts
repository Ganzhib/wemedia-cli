import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkill, skillStatus } from '../src/runtime/skills.js';
import { VERSION } from '../src/package.js';
import { PACKAGE_ROOT } from '../src/package.js';

test('installs a complete Skill once and leaves matching installations untouched', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-skill-'));
  const target = join(home, 'juejin-cli');
  try {
    assert.equal((await skillStatus(target)).state, 'missing');
    await installSkill(target, 'juejin-cli');
    const receipt = await readFile(join(target, '.wemedia-cli-install.json'), 'utf8');
    assert.ok((await readFile(join(target, 'SKILL.md'), 'utf8')).includes('name: juejin-cli'));
    assert.ok((await readFile(join(target, 'references', 'scenarios.md'), 'utf8')).includes('专栏'));
    await installSkill(target, 'juejin-cli');
    assert.equal(await readFile(join(target, '.wemedia-cli-install.json'), 'utf8'), receipt);
    assert.equal((await skillStatus(target)).version, VERSION);
  } finally { await rm(home, { recursive: true }); }
});

test('keeps user-edited Skills and reports the conflict', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-skill-'));
  const target = join(home, 'juejin-cli');
  try {
    await installSkill(target, 'juejin-cli');
    await writeFile(join(target, 'SKILL.md'), 'My instructions');
    assert.equal((await skillStatus(target)).state, 'modified');
    await assert.rejects(() => installSkill(target, 'juejin-cli'), /已有自定义 Skill/);
    assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'My instructions');
  } finally { await rm(home, { recursive: true }); }
});

test('does not take over a same-named skill created outside this package', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-skill-'));
  const target = join(home, 'juejin-cli');
  try {
    await mkdir(target);
    await writeFile(join(target, 'SKILL.md'), 'Existing skill');
    await assert.rejects(() => installSkill(target, 'juejin-cli'), /已有自定义 Skill/);
    assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'Existing skill');
  } finally { await rm(home, { recursive: true }); }
});

test('bundled drawio installs scripts and binary data without changing bytes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'juejin-drawio-'));
  try {
    const target = join(home, 'drawio-skill');
    await installSkill(target, 'drawio-skill');
    assert.deepEqual(await readFile(join(target, 'data/shape-index.json.gz')), await readFile(join(PACKAGE_ROOT, 'skills/drawio-skill/data/shape-index.json.gz')));
    assert.ok((await readFile(join(target, 'scripts/validate.py'), 'utf8')).length > 0);
    assert.equal((await skillStatus(target)).state, 'installed');
    await writeFile(join(target, 'SKILL.md'), 'custom drawio');
    await assert.rejects(installSkill(target, 'drawio-skill'), /已有自定义 Skill/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
