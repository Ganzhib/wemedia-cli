import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../../package.js';
import { CliError } from '../../shared/errors.js';
import { SessionStore, verifySession } from './session.js';

export interface SchedulerResult { code: number; stdout: string; stderr: string }
export type SchedulerExec = (command: string, args: string[]) => Promise<SchedulerResult>;
export interface SchedulerOptions {
  platform?: NodeJS.Platform; userHome?: string; uid?: number; node?: string; entry?: string;
  exec?: SchedulerExec; verify?: () => Promise<unknown>;
}
export interface SchedulePlan {
  name: string; label: string; at: string; timezone: string; backend: 'launchd' | 'systemd' | 'windows';
  runner: string; log: string; node: string; entry: string;
}
const executeFile = promisify(execFile);
const execute: SchedulerExec = async (command, args) => {
  try {
    const result = await executeFile(command, args, { encoding: 'utf8', windowsHide: true });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as Error & { code: number | string; stdout: string; stderr: string };
    if (typeof failure.code !== 'number') throw new CliError('INPUT', '无法启动系统调度器，请检查当前用户环境。', { command, code: failure.code });
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
};
function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function systemdArgument(value: string): string {
  // systemd expands % specifiers and $ variables even inside quoted ExecStart arguments.
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
}
function windowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
function powerShell(spec: Record<string, unknown>, script: string): string[] {
  const payload = Buffer.from(JSON.stringify(spec)).toString('base64');
  const source = "$ErrorActionPreference='Stop'; $spec=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + payload + "')) | ConvertFrom-Json; " + script;
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')];
}
export function validateScheduleName(name: string): string {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) throw new CliError('INPUT', '任务名称只能包含 1–40 个英文字母、数字、连字符或下划线。');
  return name;
}
export function validateScheduleTime(at: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new CliError('INPUT', '执行时间必须为 24 小时制 HH:mm，例如 09:00。');
  return at;
}
export class CheckInScheduler {
  private readonly platform: NodeJS.Platform;
  private readonly userHome: string;
  private readonly exec: SchedulerExec;
  constructor(private readonly session: SessionStore, private readonly options: SchedulerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.userHome = options.userHome ?? homedir();
    this.exec = options.exec ?? execute;
  }
  plan(at: string, name = 'daily'): SchedulePlan {
    validateScheduleTime(at); validateScheduleName(name);
    let backend: SchedulePlan['backend'];
    if (this.platform === 'darwin') backend = 'launchd';
    else if (this.platform === 'linux') backend = 'systemd';
    else if (this.platform === 'win32') backend = 'windows';
    else throw new CliError('INPUT', '自动签到支持 macOS、Windows 和使用 systemd 的 Linux。');
    const hash = createHash('sha256').update(this.session.home).digest('hex').slice(0, 12);
    return {
      name, label: 'cn.juejin-cli.checkin.' + hash + '.' + name, at,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, backend,
      runner: join(this.session.home, 'schedules', name + '.mjs'),
      log: join(this.session.home, 'schedules', name + '.log'),
      node: this.options.node ?? process.execPath,
      entry: this.options.entry ?? join(PACKAGE_ROOT, 'dist', 'cli.js'),
    };
  }
  private metadata(name: string): string {
    return join(this.session.home, 'schedules', validateScheduleName(name) + '.json');
  }
  private async checked(command: string, args: string[]): Promise<SchedulerResult> {
    const result = await this.exec(command, args);
    if (result.code !== 0) throw new CliError('INPUT', '系统定时任务操作失败。', { command, exit_code: result.code, stderr: result.stderr.trim() });
    return result;
  }
  private domain(): string {
    return 'gui/' + (this.options.uid ?? process.getuid!());
  }
  private unitPath(plan: SchedulePlan, extension: string): string {
    return join(this.userHome, '.config', 'systemd', 'user', plan.label + '.' + extension);
  }
  private agentPath(plan: SchedulePlan): string {
    return join(this.userHome, 'Library', 'LaunchAgents', plan.label + '.plist');
  }
  definition(plan: SchedulePlan): string {
    const [hour, minute] = plan.at.split(':').map(Number);
    if (plan.backend === 'launchd') {
      return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0"><dict><key>Label</key><string>' + xml(plan.label) + '</string><key>ProgramArguments</key><array><string>' + xml(plan.node) +
        '</string><string>' + xml(plan.runner) + '</string></array><key>StartCalendarInterval</key><dict><key>Hour</key><integer>' + hour +
        '</integer><key>Minute</key><integer>' + minute + '</integer></dict><key>RunAtLoad</key><false/></dict></plist>\n';
    }
    if (plan.backend === 'systemd') return '[Unit]\nDescription=Juejin daily check-in\n[Timer]\nOnCalendar=*-*-* ' + plan.at + ':00\nPersistent=true\n[Install]\nWantedBy=timers.target\n';
    return 'Windows Task Scheduler: daily at ' + plan.at + ', current interactive user, StartWhenAvailable, IgnoreNew';
  }
  private runner(plan: SchedulePlan): string {
    // Pass the profile explicitly; native schedulers do not inherit the terminal's JUEJIN_HOME.
    const args = [plan.entry, '--home', this.session.home, 'checkin', 'run', '--json'];
    return "import { spawn } from 'node:child_process';\nimport { open } from 'node:fs/promises';\n" +
      'const output = await open(' + JSON.stringify(plan.log) + ", 'a', 0o600);\ntry {\n" +
      "  await output.writeFile(JSON.stringify({event:'started',time:new Date().toISOString()})+'\\n');\n" +
      '  const child = spawn(' + JSON.stringify(plan.node) + ', ' + JSON.stringify(args) +
      ", {stdio:['ignore',output.fd,output.fd],env:{...process.env,JUEJIN_AUTO_INSTALL_SKILL:'0'}});\n" +
      "  process.exitCode = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});\n" +
      "} catch (error) { await output.writeFile(JSON.stringify({event:'error',message:error.message})+'\\n'); process.exitCode=1; }\nfinally { await output.close(); }\n";
  }
  async status(name = 'daily') {
    const plan = this.plan('09:00', name);
    let settings: SchedulePlan | undefined;
    try { settings = JSON.parse(await readFile(this.metadata(name), 'utf8')) as SchedulePlan; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (plan.backend === 'launchd') {
      const result = await this.exec('launchctl', ['print', this.domain() + '/' + plan.label]);
      if (result.code !== 0 && result.code !== 113 && result.code !== 3) throw new CliError('INPUT', '无法查询 launchd 任务。', { stderr: result.stderr });
      return { enabled: result.code === 0, registered: result.code === 0, settings };
    }
    if (plan.backend === 'systemd') {
      const result = await this.checked('systemctl', ['--user', 'show', plan.label + '.timer', '--property=LoadState', '--property=ActiveState']);
      return { enabled: result.stdout.includes('ActiveState=active'), registered: !result.stdout.includes('LoadState=not-found'), settings };
    }
    const result = await this.checked('powershell.exe', powerShell({name:plan.label},
      "$task=Get-ScheduledTask | Where-Object { $_.TaskName -eq $spec.name -and $_.TaskPath -eq '\\' }; if($null -eq $task){ @{enabled=$false;registered=$false}|ConvertTo-Json -Compress }else{ $info=$task|Get-ScheduledTaskInfo; @{enabled=($task.State -ne 'Disabled');registered=$true;last_exit_code=$info.LastTaskResult}|ConvertTo-Json -Compress }"));
    return { ...JSON.parse(result.stdout) as { enabled: boolean; registered: boolean; last_exit_code?: number }, settings };
  }
  async enable(at = '09:00', options: { name?: string; dryRun?: boolean } = {}) {
    const plan = this.plan(at, options.name);
    if (options.dryRun) return { ...plan, dry_run: true, definition: this.definition(plan) };
    await (this.options.verify ?? (() => this.session.load().then(verifySession)))();
    return this.session.withWriteLock(async () => {
      const previous = await this.status(plan.name);
      await mkdir(join(this.session.home, 'schedules'), { recursive: true, mode: 0o700 });
      await writeFile(plan.runner, this.runner(plan), { mode: 0o600 });
      if (plan.backend === 'launchd') {
        if (previous.registered) await this.checked('launchctl', ['bootout', this.domain() + '/' + plan.label]);
        const path = this.agentPath(plan);
        await mkdir(join(this.userHome, 'Library', 'LaunchAgents'), { recursive: true });
        await writeFile(path, this.definition(plan), { mode: 0o600 });
        await this.checked('launchctl', ['bootstrap', this.domain(), path]);
      } else if (plan.backend === 'systemd') {
        await mkdir(join(this.userHome, '.config', 'systemd', 'user'), { recursive: true });
        const service = '[Unit]\nDescription=Juejin daily check-in\n[Service]\nType=oneshot\nExecStart=' + systemdArgument(plan.node) + ' ' + systemdArgument(plan.runner) + '\n';
        await writeFile(this.unitPath(plan, 'service'), service, { mode: 0o600 });
        await writeFile(this.unitPath(plan, 'timer'), this.definition(plan), { mode: 0o600 });
        await this.checked('systemctl', ['--user', 'daemon-reload']);
        await this.checked('systemctl', ['--user', 'enable', '--now', plan.label + '.timer']);
        if (previous.registered) await this.checked('systemctl', ['--user', 'restart', plan.label + '.timer']);
      } else {
        await this.checked('powershell.exe', powerShell({name:plan.label,at:plan.at,node:plan.node,args:windowsArgument(plan.runner)},
          "$action=New-ScheduledTaskAction -Execute $spec.node -Argument $spec.args; $trigger=New-ScheduledTaskTrigger -Daily -At $spec.at; $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew; $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName $spec.name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null"));
      }
      await writeFile(this.metadata(plan.name), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
      return { enabled: true, ...plan };
    });
  }
  async disable(name = 'daily') {
    const plan = this.plan('09:00', name);
    return this.session.withWriteLock(async () => {
      const previous = await this.status(name);
      if (plan.backend === 'launchd') {
        if (previous.registered) await this.checked('launchctl', ['bootout', this.domain() + '/' + plan.label]);
        await rm(this.agentPath(plan), { force: true });
      } else if (plan.backend === 'systemd') {
        if (previous.registered) await this.checked('systemctl', ['--user', 'disable', '--now', plan.label + '.timer']);
        await rm(this.unitPath(plan, 'timer'), { force: true });
        await rm(this.unitPath(plan, 'service'), { force: true });
        await this.checked('systemctl', ['--user', 'daemon-reload']);
      } else if (previous.registered) {
        await this.checked('powershell.exe', powerShell({name:plan.label}, "Unregister-ScheduledTask -TaskName $spec.name -Confirm:$false"));
      }
      await rm(this.metadata(name), { force: true });
      await rm(plan.runner, { force: true });
      return { enabled: false, name, label: plan.label, log: plan.log };
    });
  }
}
