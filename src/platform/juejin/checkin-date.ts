import { CliError } from '../../shared/errors.js';

const dayMs = 86_400_000;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function checkInDate(now = new Date()): string { return formatter.format(now); }

export function supplementTimestamp(date: string, now = new Date()): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CliError('INPUT', '补签日期必须为 YYYY-MM-DD。');
  const timestamp = Date.parse(date + 'T00:00:00+08:00');
  if (!Number.isFinite(timestamp) || checkInDate(new Date(timestamp)) !== date) {
    throw new CliError('INPUT', '补签日期不存在。');
  }
  const today = Date.parse(checkInDate(now) + 'T00:00:00+08:00');
  if (timestamp >= today || timestamp < today - 30 * dayMs) {
    throw new CliError('INPUT', '只能补签北京时间最近 30 天内、不含今天的漏签日期。');
  }
  return timestamp / 1000;
}
