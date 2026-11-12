import { Command } from 'commander';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { PlatformRegistry } from '../core/registry.js';
import { defaultRegistry } from '../platform/builtins.js';
import { AccountRepository, wmHome } from '../runtime/accounts.js';
import { autoInstallSkill } from '../runtime/skills.js';
import { PublishingService, type PublishJob, type TargetJob } from '../services/publishing.js';
import { resourceSnapshotSchema } from '../core/types.js';
import { parseInput } from '../core/validation.js';
import { CliError } from '../shared/errors.js';
import { VERSION } from '../package.js';
import { CliOutput, type CliStreams } from './output.js';
import { describeCommand } from './commands/schema.js';
import { registerSkill } from './commands/skill.js';
import { registerContent } from './commands/content.js';

export interface WmProgramOptions { streams?: CliStreams; registry?: PlatformRegistry; jsonDiagnostics?: boolean }
async function jsonFile(file: string): Promise<unknown> {
  let text: string;
  if (file === '-') { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); text = Buffer.concat(chunks).toString('utf8'); }
  else text = await readFile(resolve(file), 'utf8');
  try { return JSON.parse(text); } catch { throw new CliError('INPUT', '输入文件不是有效 JSON。'); }
}
function contentOptions(command: Command): Command {
  return command.option('--options <file>', '平台选项 JSON，字段见能力 schema')
    .option('--dry-run', '只准备内容，不登录、不上传、不保存任务').option('--new-copy', '明确创建新的发布副本');
}

function targetNextAction(jobId: string, target: TargetJob) {
  switch (target.requiredAction) {
    case 'login': return { command: 'wm', args: ['auth', 'login', target.identity.platformId, '--binding', target.identity.bindingId] };
    case 'scan_in_browser': return { command: 'wm', args: ['job', 'resume', jobId] };
    case 'review_remote_changes': return { command: 'wm', args: ['job', 'get', jobId, '--json'] };
    case 'inspect_remote': return { command: 'wm', args: ['job', 'refresh', jobId] };
  }
}

export function createWmProgram(options: WmProgramOptions = {}): Command {
  const output = new CliOutput(options.streams ?? process);
  const program = new Command('wm').description('统一的多平台内容管理 CLI').version(VERSION)
    .option('--json', '输出单个 JSON 文档，错误位于 stderr').option('--home <directory>', '账号和任务目录', wmHome()).exitOverride();
  const json = () => program.opts().json === true;
  program.configureOutput({ writeOut: text => { output.streams.stdout.write(text); }, writeErr: text => { if (!options.jsonDiagnostics && !json()) output.streams.stderr.write(text); } });
  const registry = options.registry ?? defaultRegistry();
  const home = () => resolve(program.opts().home as string);
  const accounts = () => new AccountRepository(home());
  const service = () => new PublishingService(home(), registry);
  const emit = (value: unknown) => output.success(value, json());
  const emitJob = (job: PublishJob) => {
    const result = { job_id: job.id, plan_id: job.planId, capability: job.capabilityId, targets: job.targets.map(target => ({
      identity: target.identity, alias: target.alias, operation_id: target.operationId, observation: target.observation, status: target.status, execution_status: target.executionStatus, verification: target.verification, required_action: target.requiredAction, error: target.failure, next_action: targetNextAction(job.id, target), remote: target.remote, message: target.message, data: target.data,
    })), diagnostics: job.diagnostics };
    const failed = job.targets.some(target => {
      const capability = registry.capability(target.identity.platformId, job.capabilityId);
      return capability.effect !== 'remote-write' || !capability.successStates.some(state => state === target.status);
    });
    if (failed) throw new CliError('PARTIAL', '任务包含未完成的目标。', result);
    emit(result);
  };

  const platform = program.command('platform').description('发现平台、契约及调用已注册能力');
  platform.command('list').action(() => emit(registry.describe()));
  platform.command('capabilities <platform>').option('--account <alias>', '账号别名', 'main').action(async (id: string, flags: { account: string }) => {
    const definition = registry.get(id);
    const description = registry.describe(id)[0];
    const identity = await accounts().find(id, flags.account);
    if (!identity) { emit({ ...description, authentication: 'login_required' }); return; }
    emit(await accounts().use(identity, account => definition.withSession(account, async session => {
      const capabilities = [];
      for (const capability of description.capabilities) capabilities.push({ ...capability, availability: await session.probe(capability.id) });
      return { ...description, identity, profile: session.profile, authentication: 'verified', capabilities };
    })));
  });
  platform.command('exec <platform> <capability>').option('--account <alias>', '账号别名', 'main').option('--input <file>', '能力输入 JSON，- 表示 stdin').option('--dry-run', '仅解析能力输入').option('--new-copy', '明确创建新副本')
    .action(async (id: string, capabilityId: string, flags: { account: string; input?: string; dryRun?: boolean; newCopy?: boolean }) => {
      registry.capability(id, capabilityId);
      const input = flags.input ? await jsonFile(flags.input) : {};
      if (flags.dryRun) { emit({ dry_run: true, targets: await service().prepare(capabilityId, input, [id + ':' + flags.account]) }); return; }
      const result = await service().invoke(id, flags.account, capabilityId, input, flags.newCopy);
      if (result.effect === 'remote-write') emitJob(result.value); else emit(result.value);
    });

  const auth = program.command('auth').description('建立账号身份并登录平台');
  auth.command('login <platform>').option('--account <alias>', '账号别名', 'main').option('--binding <id>', '重新登录冻结的真实身份，不修改别名').action(async (id: string, flags: { account: string; binding?: string }) => {
    const definition = registry.get(id);
    const binding = flags.binding ? await accounts().reauthenticate(id, flags.binding, directory => definition.login(directory)) : await accounts().login(id, flags.account, directory => definition.login(directory));
    emit({ identity: binding.identity, name: binding.name, alias: flags.binding ? undefined : flags.account });
  });
  auth.command('status [platform]').option('--account <alias>', '账号别名', 'main').action(async (id: string | undefined, flags: { account: string }) => {
    const identities = id ? [await accounts().resolve(registry.get(id).id, flags.account)] : (await accounts().list()).map(entry => entry.binding.identity);
    if (!identities.length) throw new CliError('AUTH', '尚未建立账号绑定，请运行 wm auth login PLATFORM。');
    const result = [];
    for (const identity of new Map(identities.map(identity => [identity.bindingId, identity])).values()) {
      const profile = await accounts().use(identity, account => registry.get(identity.platformId).withSession(account, async session => session.profile));
      result.push({ identity, profile });
    }
    emit(result);
  });
  const account = program.command('account').description('账号别名与真实身份');
  account.command('list').action(async () => emit((await accounts().list()).map(entry => ({ platform: entry.platform, alias: entry.alias, identity: entry.binding.identity, name: entry.binding.name }))));
  account.command('alias <platform> <source> <alias>').option('--replace', '明确重绑已经存在的别名').action(async (id: string, source: string, alias: string, flags: { replace?: boolean }) => {
    registry.get(id); emit(await accounts().alias(id, source, alias, flags.replace));
  });

  const execute = async (file: string, flags: Record<string, unknown>, capabilityId: string) => {
    if (flags.to && flags.platform) throw new CliError('INPUT', '--to 与 --platform 只能使用一个。');
    const targets = flags.to ? String(flags.to).split(',') : [String(flags.platform ?? '') + ':' + String(flags.account ?? 'main')];
    if (!flags.to && !flags.platform) throw new CliError('INPUT', '请指定 --to 或 --platform。');
    const input = { file, options: flags.options ? await jsonFile(String(flags.options)) : undefined };
    if (flags.dryRun) { emit({ dry_run: true, targets: await service().prepare(capabilityId, input, targets) }); return; }
    emitJob(await service().run((await service().create(capabilityId, input, targets, flags.newCopy === true)).id));
  };
  const draft = program.command('draft').description('平台草稿');
  contentOptions(draft.command('create <file>').requiredOption('--platform <platform>', '目标平台').option('--account <alias>', '账号别名', 'main'))
    .action((file: string, flags: Record<string, unknown>) => execute(file, flags, 'draft.create'));
  for (const [name, capabilityId] of [['update', 'draft.update'], ['publish', 'draft.publish']] as const) {
    const command = draft.command(name === 'update' ? 'update <file>' : 'publish')
      .requiredOption('--platform <platform>', '目标平台').option('--account <alias>', '账号别名', 'main')
      .requiredOption('--base <file>', 'resource.get 保存的完整快照 JSON').option('--options <file>', '平台选项 JSON').option('--dry-run', '只准备内容');
    const action = async (file: string | undefined, flags: { platform: string; account: string; base: string; options?: string; dryRun?: boolean }) => {
      const base = await jsonFile(flags.base); const options = flags.options ? await jsonFile(flags.options) : undefined;
      const input = name === 'update' ? { file, base, options } : { base, ...options as object };
      if (flags.dryRun) { emit({ dry_run: true, targets: await service().prepare(capabilityId, input, [flags.platform + ':' + flags.account]) }); return; }
      const result = await service().invoke(flags.platform, flags.account, capabilityId, input);
      if (result.effect === 'remote-write') emitJob(result.value);
    };
    if (name === 'update') command.action((file: string, flags) => action(file, flags));
    else command.action(flags => action(undefined, flags));
  }
  program.command('resource').description('读取平台资源和版本基准').command('get <kind> <id>')
    .requiredOption('--platform <platform>', '目标平台').option('--account <alias>', '账号别名', 'main').option('--selector <file>', '平台子项定位 JSON').option('--output <file>', '保存快照 JSON')
    .action(async (kind: string, id: string, flags: { platform: string; account: string; selector?: string; output?: string }) => {
      const result = await service().invoke(flags.platform, flags.account, 'resource.get', { resource: { kind, id, ...(flags.selector ? { selector: await jsonFile(flags.selector) } : {}) } });
      if (flags.output) await writeFile(resolve(flags.output), JSON.stringify(result.value, null, 2), { mode: 0o600 });
      emit(result.value);
    });
  const article = program.command('article').description('平台内容');
  contentOptions(article.command('publish <file>').option('--to <targets>', 'platform:account，逗号分隔').option('--platform <platform>', '单个平台').option('--account <alias>', '账号别名', 'main'))
    .action((file: string, flags: Record<string, unknown>) => execute(file, flags, 'content.publish'));
  article.command('preview <file>').requiredOption('--platform <platform>', '目标平台').option('--capability <id>', '准备的目标能力', 'content.publish').option('--options <file>', '平台选项 JSON').option('--output <file>', '保存平台预览 JSON')
    .action(async (file: string, flags: { platform: string; capability: string; options?: string; output?: string }) => {
      const prepared = await service().prepare(flags.capability, { file, options: flags.options ? await jsonFile(flags.options) : undefined }, [flags.platform]);
      if (flags.output) await writeFile(resolve(flags.output), JSON.stringify(prepared[0].prepared, null, 2), { mode: 0o600 });
      emit({ preview: true, prepared: prepared[0].prepared, output: flags.output });
    });
  for (const [command, capabilityId] of [[draft, 'draft.list'], [article, 'article.list']] as const) {
    command.command('list').requiredOption('--platform <platform>', '目标平台').option('--account <alias>', '账号别名', 'main').option('--limit <number>', '最多条数', Number, 20)
      .action(async (flags: { platform: string; account: string; limit: number }) => emit((await service().invoke(flags.platform, flags.account, capabilityId, { limit: flags.limit })).value));
  }
  const plan = program.command('plan').description('冻结内容、目标身份和平台产物');
  plan.command('create <capability>').requiredOption('--to <targets>', 'platform:account，逗号分隔').requiredOption('--input <file>', '能力输入 JSON，- 表示 stdin').option('--new-copy', '创建新的发布副本')
    .action(async (capability: string, flags: { to: string; input: string; newCopy?: boolean }) => emit(await service().planning.create(capability, await jsonFile(flags.input), flags.to.split(','), flags.newCopy)));
  plan.command('get <id>').action(async (id: string) => emit(await service().planning.get(id)));
  plan.command('inspect <id>').action(async (id: string) => {
    const planning = service().planning; const frozen = await planning.get(id);
    const targets = [];
    for (const target of frozen.targets) targets.push({ ...target, ...(await planning.variant(target)) });
    emit({ ...frozen, targets });
  });
  plan.command('diff <before> <after>').action(async (before: string, after: string) => emit(await service().planning.diff(before, after)));
  plan.command('export <id>').requiredOption('--directory <path>', '导出平台实际产物目录').action(async (id: string, flags: { directory: string }) => {
    const { mkdir, copyFile } = await import('node:fs/promises'); const { join } = await import('node:path');
    const planning = service().planning; const frozen = await planning.get(id); const files = [];
    for (const target of frozen.targets) {
      const { variant } = await planning.variant(target); const directory = resolve(flags.directory, target.identity.platformId, target.identity.bindingId);
      await mkdir(directory, { recursive: true });
      for (const [index, output] of variant.outputs.entries()) {
        const file = join(directory, index + '-' + output.artifact.digest + output.artifact.extension);
        await copyFile(planning.objects.path(output.artifact), file); files.push({ identity: target.identity, role: output.role, file, artifact: output.artifact });
      }
    }
    emit({ plan_id: frozen.id, files });
  });
  plan.command('run <id>').action(async (id: string) => emitJob(await service().run((await service().start(id)).id)));
  article.command('plan <file>').requiredOption('--to <targets>', 'platform:account，逗号分隔').option('--intent <intent>', 'publish 或 draft', 'publish').option('--options <file>', '平台选项 JSON').option('--new-copy', '创建新的发布副本')
    .action(async (file: string, flags: { to: string; intent: string; options?: string; newCopy?: boolean }) => {
      if (!['publish', 'draft'].includes(flags.intent)) throw new CliError('INPUT', '--intent 仅支持 publish 或 draft。');
      emit(await service().planning.create(flags.intent === 'draft' ? 'draft.create' : 'content.publish', { file, options: flags.options ? await jsonFile(flags.options) : undefined }, flags.to.split(','), flags.newCopy));
    });
  const publication = program.command('publication').description('查询本地远端引用与修订关联');
  publication.command('list').action(async () => emit(await service().publications.list()));
  publication.command('get <id>').action(async (id: string) => emit(await service().publications.get(id)));
  publication.command('refresh <id>').action(async (id: string) => {
    const publishing = service();
    emit(await publishing.publications.refresh(id, async (identity, resource) => parseInput(resourceSnapshotSchema, await publishing.read(identity, 'resource.get', { resource }))));
  });
  publication.command('rebuild').action(async () => emit(await service().publications.rebuild()));
  const job = program.command('job').description('执行回执与恢复');
  job.command('get <id>').action(async (id: string) => emit(await service().get(id)));
  job.command('resume <id>').action(async (id: string) => emitJob(await service().run(id)));
  job.command('refresh <id>').action(async (id: string) => emit(await service().refresh(id)));
  program.command('schema [path...]').description('命令语法及注册能力的实际输入输出契约')
    .option('--platform <id>', '只查看此平台的能力，不登录')
    .option('--capability <id>', '只查看此能力，需同时指定平台')
    .action((path: string[] = [], flags: { platform?: string; capability?: string }) => {
    let command = program;
    for (const name of path) { const child = command.commands.find(child => child.name() === name); if (!child) throw new CliError('INPUT', '找不到命令路径：' + path.join(' ')); command = child; }
    if (flags.capability && !flags.platform) throw new CliError('INPUT', '--capability 需要指定 --platform。');
    if (flags.platform && flags.capability) registry.capability(flags.platform, flags.capability);
    const platforms = registry.describe(flags.platform);
    if (flags.capability) for (const platform of platforms) platform.capabilities = platform.capabilities.filter(capability => capability.id === flags.capability);
    emit({ command: describeCommand(command), global_options: describeCommand(program).options, platforms });
  });
  registerSkill({ program, emit });
  registerContent({ program, emit });
  program.command('doctor').description('检查本地环境').action(async () => {
    let browserInstalled = true;
    try { await access(chromium.executablePath()); } catch { browserInstalled = false; }
    emit({ node: process.version, version: VERSION, home: home(), browser_installed: browserInstalled, accounts: (await accounts().list()).length });
  });
  return program;
}

export async function runWmCli(args: string[], options: WmProgramOptions = {}): Promise<number> {
  const output = new CliOutput(options.streams ?? process);
  try {
    await autoInstallSkill({ quiet: args.includes('--json') });
    await createWmProgram({ ...options, jsonDiagnostics: args.includes('--json') }).parseAsync(args, { from: 'user' });
    return 0;
  } catch (error) { return output.failure(error, args.includes('--json')); }
}
