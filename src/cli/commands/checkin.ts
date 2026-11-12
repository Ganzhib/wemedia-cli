import type { CommandContext } from '../context.js';
import { CheckInScheduler } from '../../platform/juejin/schedule.js';
import { checkInDate } from '../../platform/juejin/checkin-date.js';

export function registerCheckIn(context: CommandContext): void {
  const checkin = context.program.command('checkin').description('每日签到、记录、补签与定时任务');
  checkin.command('status').description('查询北京时间今日签到状态').action(async () => {
    context.emit({ date: checkInDate(), check_in_done: await (await context.services(true)).client.checkInStatus() });
  });
  checkin.command('run').description('执行一次签到；已签到则跳过').option('--dry-run', '只查询今日状态，不签到')
    .action(async (options: { dryRun?: boolean }) => context.emit(await context.growth(services => services.writing.checkIn(options))));
  checkin.command('stats').description('累计与连续签到天数').action(async () => context.emit(await (await context.services(true)).client.checkInCounts()));
  checkin.command('calendar').description('查询本月或上月签到记录（状态 0/1 今日未签/已签，2/3 过去未签/已签，4 未来）')
    .option('--previous-month', '查询上月记录').action(async (options: { previousMonth?: boolean }) => {
      context.emit({ period: options.previousMonth ? 'previous_month' : 'current_month', days: await (await context.services(true)).client.checkInCalendar(options.previousMonth) });
    });
  checkin.command('balance').description('矿石余额').action(async () => context.emit({ points: await (await context.services(true)).client.points() }));
  checkin.command('cards').description('补签卡数量').action(async () => context.emit({ cards: await (await context.services(true)).client.supplementCards() }));
  checkin.command('supplement <date>').description('使用补签卡补签 YYYY-MM-DD，北京时间最近 30 天、不含今天')
    .option('--dry-run', '只查询平台补签预览，不消耗补签卡')
    .action(async (date: string, options: { dryRun?: boolean }) => context.emit(await context.growth(services => services.writing.supplementCheckIn(date, options))));
  const schedule = checkin.command('schedule').description('选择启用、查看或关闭系统每日签到任务，时间使用电脑本地时区');
  schedule.command('enable').description('安装并启用每日签到；同名任务更新时间，不重复创建')
    .option('--at <HH:mm>', '每天执行时间（电脑本地时区）', '09:00')
    .option('--name <name>', '任务名称', 'daily')
    .option('--dry-run', '预览系统任务定义，不安装或签到')
    .action(async (options: { at: string; name: string; dryRun?: boolean }) =>
      context.emit(await new CheckInScheduler(context.session()).enable(options.at, options)));
  schedule.command('status').description('查询系统调度器中的实际启用状态')
    .option('--name <name>', '任务名称', 'daily')
    .action(async (options: { name: string }) => context.emit(await new CheckInScheduler(context.session()).status(options.name)));
  schedule.command('disable').description('停止并移除任务，保留执行日志')
    .option('--name <name>', '任务名称', 'daily')
    .action(async (options: { name: string }) => context.emit(await new CheckInScheduler(context.session()).disable(options.name)));
  checkin.command('rules').description('读取平台当前签到规则').action(async () => context.emit(await (await context.services()).client.checkInRules()));
}
