import { Command, Option } from 'commander';
import { join, resolve } from 'node:path';
import { installSkill, skillDirectory, skillStatus, type SkillAgent, type BundledSkillName } from '../../runtime/skills.js';
import { dirname } from 'node:path';
import type { CommandContext } from '../context.js';

function skillOptions(command: Command): Command {
  return command.addOption(new Option('--agent <agent>', 'shared 适用于 Codex/Cursor，claude 用于 Claude Code').choices(['shared', 'claude', 'cursor']).default('shared'))
    .addOption(new Option('--name <name>', '内置技能').choices(['wemedia-cli', 'juejin-cli', 'drawio-skill']).default('wemedia-cli'))
    .option('--dir <directory>', '自定义 skills 根目录');
}
type SkillOptions = { agent: SkillAgent; dir?: string; name: BundledSkillName };
function skillTarget(options: SkillOptions): string {
  return join(options.dir ? resolve(options.dir) : dirname(skillDirectory(options.agent)), options.name);
}

export function registerSkill(context: Pick<CommandContext, 'program' | 'emit'>): void {
  const skill = context.program.command('skill').description('安装随 CLI 分发的 Agent Skill');
  skillOptions(skill.command('install')).action(async (options: SkillOptions) => context.emit(await installSkill(skillTarget(options), options.name)));
  skillOptions(skill.command('status')).action(async (options: SkillOptions) => context.emit(await skillStatus(skillTarget(options))));
}
