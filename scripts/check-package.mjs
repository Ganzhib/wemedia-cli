import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'wemedia-package-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run check:package');
const skills = join(directory, 'skills');
const env = { ...process.env, WM_SKILLS_DIR: skills, WM_AUTO_INSTALL_SKILL: '1', npm_config_registry: 'https://registry.npmjs.org/' };
function run(args) { return execFileSync(process.execPath, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }); }
try {
  if (process.platform !== 'win32') assert.ok((await stat(new URL('../dist/wm.js', import.meta.url))).mode & 0o111, 'Rebuilding a linked CLI must preserve execute permissions');
  const [packed] = JSON.parse(run([npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', directory]));
  assert.equal(packed.name, '@ganzhibin/wemedia-cli');
  const paths = new Set(packed.files.map(file => file.path));
  for (const path of ['dist/wm.js', 'dist/core/registry.js', 'dist/core/capability.js', 'dist/core/platform.js', 'dist/services/publishing.js', 'dist/platform/wechat/adapter.js', 'dist/platform/xiaohongshu/adapter.js', 'dist/platform/zhihu/adapter.js', 'licenses/dsh-article-share-MIT.txt', 'licenses/article-sync-action-MIT.txt', 'skills/wm/SKILL.md', 'licenses/baoyu-skills-MIT.txt', 'licenses/xiaohongshu-skills-MIT.txt']) assert.ok(paths.has(path), 'Missing ' + path);
  assert.deepEqual([...paths].filter(path => path.startsWith('skills/') && path.split('/').length === 3 && path.endsWith('/SKILL.md')), ['skills/wm/SKILL.md']);
  assert.ok(!paths.has('dist/cli.js') && !paths.has('dist/cli/program.js'), 'No legacy executable or command tree');
  assert.ok(![...paths].some(path => path.startsWith('skills/') && !path.startsWith('skills/wm/')));
  assert.ok(![...paths].some(path => path.includes('session.json') || path.includes('browser-profile/') || path.startsWith('accounts/')));
  const prefix = join(directory, 'install');
  run([npm, 'install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', join(directory, packed.filename)]);
  const root = join(prefix, 'node_modules', '@ganzhibin', 'wemedia-cli');
  const cli = join(root, 'dist', 'wm.js');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(metadata.bin, { wm: 'dist/wm.js' });
  assert.equal(run([cli, '--version']).trim(), metadata.version);
  assert.equal(JSON.parse(run([cli, 'schema', 'article', 'publish', '--json'])).data.command.name, 'publish');
  assert.equal(JSON.parse(run([cli, 'platform', 'list', '--json'])).data.length, 4);
  assert.equal(JSON.parse(run([cli, 'skill', 'status', '--json'])).data.state, 'installed');
  const skillSchema = JSON.parse(run([cli, 'schema', 'skill', 'install', '--json'])).data.command;
  assert.ok(!skillSchema.options.some(option => option.flags.startsWith('--name')));
  const legacyName = spawnSync(process.execPath, [cli, 'skill', 'install', '--name', 'juejin-cli', '--json'], { env, encoding: 'utf8' });
  assert.equal(legacyName.status, 2);
  assert.equal(JSON.parse(legacyName.stderr).error.code, 'INPUT');
  await access(join(skills, 'wm', 'SKILL.md'));
  for (const name of ['wechat', 'xiaohongshu', 'juejin', 'zhihu']) await access(join(skills, 'wm', 'references', name + '.md'));
  const unauthenticated = spawnSync(process.execPath, [cli, '--home', join(directory, 'empty-home'), 'auth', 'status', '--json'], { env, encoding: 'utf8' });
  assert.equal(unauthenticated.status, 3);
  assert.equal(JSON.parse(unauthenticated.stderr).error.code, 'AUTH');
  await rm(skills, { recursive: true });
  run([cli, '--help']);
  await access(join(skills, 'wm', 'SKILL.md'));
  console.log('PASS real tarball installation, wm binary, schema, platform discovery, authentication boundary and skill recovery (' + metadata.version + ')');
} finally { await rm(directory, { recursive: true, force: true }); }
