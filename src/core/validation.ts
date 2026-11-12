import { z } from 'zod';
import { CliError } from '../shared/errors.js';

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CliError('INPUT', '输入不符合能力契约。', {
    issues: result.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
  });
  return result.data;
}

