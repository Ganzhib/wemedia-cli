import { Command } from 'commander';
import { VERSION } from '../package.js';
import { defaultHome } from '../platform/juejin/session.js';
import { autoInstallSkill } from '../runtime/skills.js';
import { CommandContext, type ServiceFactory, type GrowthServiceRunner } from './context.js';
import { CliOutput, type CliStreams } from './output.js';
import { registerAuth } from './commands/auth.js';
import { registerDiscovery } from './commands/discovery.js';
import { registerArticle } from './commands/article.js';
import { registerDraft } from './commands/draft.js';
import { registerColumn } from './commands/column.js';
import { registerImage } from './commands/image.js';
import { registerHistory } from './commands/history.js';
import { registerSkill } from './commands/skill.js';
import { registerCheckIn } from './commands/checkin.js';
import { registerLottery } from './commands/lottery.js';
import { registerSchema } from './commands/schema.js';

export interface ProgramOptions {
  streams?: CliStreams;
  services?: ServiceFactory;
  growth?: GrowthServiceRunner;
  jsonDiagnostics?: boolean;
}

export function createProgram(options: ProgramOptions = {}): Command {
  const output = new CliOutput(options.streams ?? process);
  const program = new Command();
  program.name('juejin').description('稀土掘金 CLI：文章、草稿、专栏、签到与抽奖').version(VERSION)
    .option('--json', '输出单行 JSON，错误也使用 JSON')
    .option('--home <directory>', '会话与操作记录目录', defaultHome())
    .showHelpAfterError().exitOverride();
  program.configureOutput({
    writeOut: text => { output.streams.stdout.write(text); },
    writeErr: text => { if (!options.jsonDiagnostics) output.streams.stderr.write(text); },
  });
  const context = new CommandContext(program, output, options.services, options.growth);
  registerAuth(context);
  registerDiscovery(context);
  registerArticle(context);
  registerDraft(context);
  registerColumn(context);
  registerImage(context);
  registerHistory(context);
  registerCheckIn(context);
  registerLottery(context);
  registerSkill(context);
  registerSchema(context);
  return program;
}

export async function runCli(arguments_: string[], options: ProgramOptions = {}): Promise<number> {
  const json = arguments_.includes('--json');
  const program = createProgram({ ...options, jsonDiagnostics: json });
  const started = Date.now();
  const progress = json ? undefined : setInterval(() => {
    (options.streams ?? process).stderr.write(`仍在处理，已等待 ${Math.round((Date.now() - started) / 1000)} 秒…\n`);
  }, 5000);
  try {
    // Covers npx and installs made with lifecycle scripts disabled.
    if (!arguments_.includes('skill')) await autoInstallSkill({ quiet: json });
    await program.parseAsync(arguments_, { from: 'user' });
    return 0;
  } catch (error) {
    return new CliOutput(options.streams ?? process).failure(error, json);
  } finally {
    if (progress) clearInterval(progress);
  }
}
