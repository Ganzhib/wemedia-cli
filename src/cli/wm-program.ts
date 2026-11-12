import { Command } from 'commander';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { PlatformRegistry } from '../core/registry.js';
import type { Intent } from '../core/types.js';
import { createJuejinAdapter } from '../platform/juejin/adapter.js';
import { createWechatAdapter } from '../platform/wechat/adapter.js';
import { createXiaohongshuAdapter } from '../platform/xiaohongshu/adapter.js';
import { AccountStore, listAccounts, wmHome } from '../runtime/accounts.js';
import { autoInstallSkill } from '../runtime/skills.js';
import { PublishingService, type PublishJob } from '../services/publishing.js';
import { CliError } from '../shared/errors.js';
import { VERSION } from '../package.js';
import { CliOutput, type CliStreams } from './output.js';
import { describeCommand } from './commands/schema.js';
import { registerSkill } from './commands/skill.js';

export interface WmProgramOptions { streams?: CliStreams; registry?: PlatformRegistry; jsonDiagnostics?: boolean }
export function defaultRegistry(): PlatformRegistry {
  return new PlatformRegistry([createJuejinAdapter(), createXiaohongshuAdapter(), createWechatAdapter()]);
}

function limit(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100) throw new CliError('INPUT', 'limit 必须为 1–100 的整数。');
  return number;
}

function articleOptions(command: Command): Command {
  return command.option('--title <title>', '覆盖标题').option('--summary <text>', '摘要')
    .option('--author <name>', '作者').option('--cover <file>', '本地封面')
    .option('--tags <names>', '逗号分隔的标签或话题').option('--category <category>', '平台分类')
    .option('--columns <ids>', '掘金专栏 ID，逗号分隔').option('--content-file <file>', '平台短文正文文件')
    .option('--dry-run', '仅本地解析和校验，不登录、不上传、不保存任务').option('--new-copy', '明确创建新副本，不复用已有任务');
}

async function overrides(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  const metadata: Record<string, unknown> = {};
  for (const name of ['title', 'summary', 'author', 'cover', 'tags', 'category', 'columns']) {
    if (options[name] !== undefined) metadata[name] = options[name];
  }
  if (options.contentFile) metadata.content = await readFile(resolve(options.contentFile as string), 'utf8');
  return metadata;
}

export function createWmProgram(options: WmProgramOptions = {}): Command {
  const output = new CliOutput(options.streams ?? process);
  const program = new Command('wm').description('自媒体多平台文章发布 CLI：登录、草稿、发布与任务回执').version(VERSION)
    .option('--json', '输出单个 JSON 文档，失败使用非零退出码')
    .option('--home <directory>', '账号和任务目录', wmHome()).exitOverride();
  const json = () => program.opts<{ json?: boolean }>().json === true;
  program.configureOutput({ writeOut: text => { output.streams.stdout.write(text); }, writeErr: text => { if (!options.jsonDiagnostics && !json()) output.streams.stderr.write(text); } });
  const registry = options.registry ?? defaultRegistry();
  const home = () => resolve(program.opts<{ home: string }>().home);
  const service = () => new PublishingService(home(), registry);
  const emit = (value: unknown) => output.success(value, json());
  const emitJob = (job: PublishJob) => {
    const result = { job_id: job.id, intent: job.intent, targets: job.targets.map(target => ({
      platform: target.platform, account: target.account, status: target.status, remote: target.remote, message: target.message,
    })) };
    const failed = job.targets.filter(target => ['rejected', 'unknown', 'waiting_for_verification', 'running'].includes(target.status));
    if (failed.length) throw new CliError('PARTIAL', '任务有未完成的目标，请保留任务 ID 后查询或恢复。', result);
    emit(result);
  };

  const platform = program.command('platform').description('发现已实现的平台能力');
  platform.command('list').action(() => emit(registry.describe()));
  platform.command('capabilities <platform>').option('--account <alias>', '账号别名', 'main').action(async (id: string, flags: { account: string }) => {
    const adapter = registry.get(id);
    const account = new AccountStore(home(), id, flags.account);
    const configured = await account.profile();
    const profile = configured ? await account.lock(() => adapter.status(account)) : undefined;
    emit({ ...registry.describe().find(platform => platform.id === adapter.id), account: profile, authentication: profile ? 'verified' : 'login_required' });
  });

  const auth = program.command('auth').description('只需平台登录，无需提取 Cookie 或配置开发者密钥');
  auth.command('login <platform>').option('--account <alias>', '账号别名', 'main').action(async (id: string, flags: { account: string }) => {
    const adapter = registry.get(id);
    const account = new AccountStore(home(), adapter.id, flags.account);
    emit(await account.lock(async () => {
      const profile = await account.verify(await adapter.login(account));
      await account.save(profile);
      return { platform: adapter.id, account: flags.account, profile };
    }));
  });
  auth.command('status [platform]').option('--account <alias>', '账号别名', 'main').action(async (id: string | undefined, flags: { account: string }) => {
    const accounts = id ? [{ platform: registry.get(id).id, alias: flags.account }] : await listAccounts(home());
    if (!accounts.length) throw new CliError('AUTH', '尚未配置账号，请运行 wm auth login <platform>。');
    const result = [];
    for (const entry of accounts) {
      const account = new AccountStore(home(), entry.platform, entry.alias);
      if (!await account.profile()) throw new CliError('AUTH', '此账号别名尚未登录。');
      const profile = await account.lock(() => registry.get(entry.platform).status(account));
      result.push({ platform: entry.platform, account: entry.alias, profile });
    }
    emit(result);
  });
  program.command('account').description('查看本机绑定的账号').command('list').action(async () => emit(await listAccounts(home())));

  const execute = async (file: string, flags: Record<string, unknown>, intent: Intent) => {
    if (flags.to && flags.platform) throw new CliError('INPUT', '--to 与 --platform 只能使用一个。');
    const destinations = flags.to ? (flags.to as string).split(',') : [String(flags.platform ?? '') + ':' + String(flags.account)];
    if (!flags.to && !flags.platform) throw new CliError('INPUT', '请指定 --to 或 --platform。');
    const metadata = await overrides(flags);
    if (flags.dryRun) {
      const prepared = await service().prepare(file, destinations, intent, metadata);
      emit({ dry_run: true, targets: prepared.targets });
      return;
    }
    const job = await service().create(file, destinations, intent, metadata, flags.newCopy === true);
    emitJob(await service().run(job.id));
  };
  const draft = program.command('draft').description('创建及查询平台草稿');
  articleOptions(draft.command('create <file>').requiredOption('--platform <platform>', '目标平台').option('--account <alias>', '账号别名', 'main'))
    .action((file: string, flags: Record<string, unknown>) => execute(file, flags, 'draft'));
  const article = program.command('article').description('预览、发布及查询文章');
  articleOptions(article.command('publish <file>').option('--to <targets>', '逗号分隔的 platform:account').option('--platform <platform>', '单个目标平台').option('--account <alias>', '账号别名', 'main'))
    .action((file: string, flags: Record<string, unknown>) => execute(file, flags, 'publish'));
  articleOptions(article.command('preview <file>').requiredOption('--platform <platform>', '目标平台').option('--output <file>', '另存平台渲染结果'))
    .action(async (file: string, flags: Record<string, unknown>) => {
      const adapter = registry.get(flags.platform as string);
      const intent = adapter.operations.draft ? 'draft' : 'publish';
      const prepared = await service().prepare(file, [adapter.id], intent, await overrides(flags));
      if (flags.output) await writeFile(resolve(flags.output as string), prepared.targets[0].article.body, { mode: 0o600 });
      emit({ preview: true, ...prepared.targets[0].article, output: flags.output });
    });
  for (const [command, kind] of [[draft, 'draft'], [article, 'article']] as const) {
    command.command('list').requiredOption('--platform <platform>', '目标平台').option('--account <alias>', '账号别名', 'main').option('--limit <number>', '最多 100 条', limit, 20)
      .action(async (flags: { platform: string; account: string; limit: number }) => {
        const adapter = registry.get(flags.platform);
        const query = adapter.lists[kind];
        if (!query) throw new CliError('UNSUPPORTED', adapter.name + ' 尚未实现此列表查询。');
        const account = new AccountStore(home(), adapter.id, flags.account);
        if (!await account.profile()) throw new CliError('AUTH', '请先运行 wm auth login ' + adapter.id);
        emit(await account.lock(() => query.run(account, flags.limit)));
      });
  }

  const job = program.command('job').description('查看、回查及恢复持久化发布任务');
  job.command('get <id>').action(async (id: string) => emit(await service().get(id)));
  job.command('resume <id>').action(async (id: string) => emitJob(await service().run(id)));
  job.command('refresh <id>').action(async (id: string) => emit(await service().refresh(id)));
  program.command('schema [path...]').description('从实际命令定义查询参数契约').action((path: string[] = []) => {
    let command = program;
    for (const name of path) {
      const child = command.commands.find(child => child.name() === name);
      if (!child) throw new CliError('INPUT', '找不到命令路径：' + path.join(' '));
      command = child;
    }
    emit({ command: describeCommand(command), global_options: describeCommand(program).options });
  });
  registerSkill({ program, emit });
  program.command('doctor').description('检查本机运行环境，不访问平台或执行发布').action(async () => {
    let installed = true;
    try { await access(chromium.executablePath()); } catch { installed = false; }
    emit({ node: process.version, version: VERSION, home: home(), browser_installed: installed, browser_setup: '登录时自动准备', accounts: await listAccounts(home()) });
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
