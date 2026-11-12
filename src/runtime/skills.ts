import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { CliError } from '../shared/errors.js';
import { PACKAGE_NAME, PACKAGE_ROOT, VERSION } from '../package.js';

export type SkillAgent = 'shared' | 'claude' | 'cursor';
const SKILL_NAME = 'wm';
const BUNDLED_SKILL = join(PACKAGE_ROOT, 'skills', SKILL_NAME);
const RECEIPT = '.wm-install.json';
interface SkillReceipt { package: string; version: string; files: Record<string, string> }
export interface SkillStatus {
  path: string;
  state: 'missing' | 'installed' | 'modified' | 'unmanaged';
  version?: string;
}

export function skillDirectory(agent: SkillAgent = 'shared'): string {
  if (process.env.WM_SKILLS_DIR) return join(resolve(process.env.WM_SKILLS_DIR), SKILL_NAME);
  if (agent === 'claude') return join(homedir(), '.claude', 'skills', SKILL_NAME);
  if (agent === 'cursor') return join(homedir(), '.cursor', 'skills', SKILL_NAME);
  return join(homedir(), '.agents', 'skills', SKILL_NAME);
}

function digest(content: string | Uint8Array): string { return createHash('sha256').update(content).digest('hex'); }

async function bundledFiles(directory = BUNDLED_SKILL, prefix = ''): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, await bundledFiles(join(directory, entry.name), relative));
    else files[relative] = await readFile(join(directory, entry.name));
  }
  return files;
}

async function inspectInstallation(directory: string): Promise<{ status: SkillStatus; receipt?: SkillReceipt }> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) return { status: { path: directory, state: 'unmanaged' } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: { path: directory, state: 'missing' } };
    throw error;
  }
  let receipt: SkillReceipt;
  try { receipt = JSON.parse(await readFile(join(directory, RECEIPT), 'utf8')) as SkillReceipt; }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return { status: { path: directory, state: 'unmanaged' } };
    throw error;
  }
  if (receipt.package !== PACKAGE_NAME) return { status: { path: directory, state: 'unmanaged' } };
  for (const [relative, expected] of Object.entries(receipt.files)) {
    // The receipt is local input. Never follow a path out of the owned skill folder.
    const path = resolve(directory, relative);
    if (!path.startsWith(resolve(directory) + sep)) throw new CliError('INPUT', 'Skill 安装记录包含非法路径。');
    let content: Buffer;
    try { content = await readFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: { path: directory, state: 'modified', version: receipt.version }, receipt };
      throw error;
    }
    if (digest(content) !== expected) return { status: { path: directory, state: 'modified', version: receipt.version }, receipt };
  }
  return { status: { path: directory, state: 'installed', version: receipt.version }, receipt };
}

export async function skillStatus(directory = skillDirectory()): Promise<SkillStatus> {
  return (await inspectInstallation(directory)).status;
}

export async function installSkill(directory = skillDirectory()): Promise<SkillStatus> {
  const { status, receipt: previous } = await inspectInstallation(directory);
  if (status.state === 'modified' || status.state === 'unmanaged') {
    throw new CliError('INPUT', `已有自定义 Skill，已保留原文件：${directory}。请选择其他目录或先备份并移走该目录。`);
  }
  const files = await bundledFiles();
  const hashes = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, digest(content)]));
  if (previous?.version === VERSION && JSON.stringify(previous.files) === JSON.stringify(hashes)) return status;
  await mkdir(directory, { recursive: true });
  // Write only files listed by this package; unrelated user files are retained.
  for (const [relative, content] of Object.entries(files)) {
    const path = join(directory, relative);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, content);
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  for (const relative of Object.keys(previous?.files ?? {})) {
    if (!(relative in files)) await rm(join(directory, relative), { force: true });
  }
  const receipt: SkillReceipt = { package: PACKAGE_NAME, version: VERSION, files: hashes };
  await writeFile(join(directory, RECEIPT), JSON.stringify(receipt, null, 2) + '\n');
  return { path: directory, state: 'installed', version: VERSION };
}

export async function autoInstallSkill(options: { quiet?: boolean } = {}): Promise<void> {
  if (process.env.WM_AUTO_INSTALL_SKILL === '0') return;
  const directories = [skillDirectory()];
  if (!process.env.WM_SKILLS_DIR) {
    try {
      await lstat(join(homedir(), '.claude'));
      directories.push(skillDirectory('claude'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const directory of directories) {
    try {
      await installSkill(directory);
    } catch (error) {
      // An unwritable or customized skill directory must not disable the CLI itself.
      if (!options.quiet) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Skill 自动安装未完成：${message} 可运行 wm skill install 手动处理。\n`);
      }
    }
  }
}
