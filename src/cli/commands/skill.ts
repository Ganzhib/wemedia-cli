import { Command, Option } from 'commander';
import { join, resolve } from 'node:path';
import { installSkill, skillDirectory, skillStatus, type SkillAgent } from '../../runtime/skills.js';
import type { CommandContext } from '../context.js';

function skillOptions(command: Command): Command {
  return command.addOption(new Option('--agent <agent>', 'shared 适用于 Codex/Cursor，claude 用于 Claude Code').choices(['shared', 'claude', 'cursor']).default('shared'))
    .option('--dir <directory>', '自定义 skills 根目录');
}
type SkillOptions = { agent: SkillAgent; dir?: string };
function skillTarget(options: SkillOptions): string {
  if (options.dir) return join(resolve(options.dir), 'wm');
  return skillDirectory(options.agent);
}

export function registerSkill(context: Pick<CommandContext, 'program' | 'emit'>): void {
  const skill = context.program.command('skill').description('安装或检查唯一的 wm Agent Skill');
  skillOptions(skill.command('install')).action(async (options: SkillOptions) => context.emit(await installSkill(skillTarget(options))));
  skillOptions(skill.command('status')).action(async (options: SkillOptions) => context.emit(await skillStatus(skillTarget(options))));
}
