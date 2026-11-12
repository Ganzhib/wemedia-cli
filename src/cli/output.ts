import { CommanderError } from 'commander';
import { CliError, exitCode } from '../shared/errors.js';

export interface CliStreams {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

export class CliOutput {
  constructor(readonly streams: CliStreams) {}

  success(value: unknown, json: boolean): void {
    this.streams.stdout.write(JSON.stringify({ ok: true, data: value }, null, json ? undefined : 2) + '\n');
    if (!json && value && typeof value === 'object' && 'status' in value && value.status === 'submitted') {
      this.streams.stderr.write('平台已接受提交，审核或索引完成前详情可能暂时不可见。请保留返回的 ID，勿重复提交。\n');
    }
  }

  text(content: string): void { this.streams.stdout.write(content); }

  failure(error: unknown, json: boolean): number {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    let failure: CliError;
    if (error instanceof CliError) failure = error;
    else if (error instanceof CommanderError) failure = new CliError('INPUT', error.message);
    else if (error instanceof Error) failure = new CliError('INTERNAL', error.message);
    else failure = new CliError('INTERNAL', String(error));
    if (json) {
      this.streams.stderr.write(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message, details: failure.details } }) + '\n');
    } else {
      this.streams.stderr.write(`${failure.code}: ${failure.message}\n`);
      if (failure.details?.job_id) {
        this.streams.stderr.write(JSON.stringify(failure.details) + '\n请运行 wm job get ' + String(failure.details.job_id) + ' --json 核对任务。\n');
      }
      if (failure.details?.operation_id || failure.details?.draft_id || failure.details?.column_id || failure.details?.result) {
        this.streams.stderr.write(`操作回执：${JSON.stringify(failure.details)}\n请运行 juejin history --json 核对结果。\n`);
      }
    }
    return exitCode(failure);
  }
}
