import { z } from 'zod';
import { remoteReferenceSchema } from './types.js';

export const listInputSchema = z.strictObject({ limit: z.int().min(1).max(100).default(20) });
export const resourceListSchema = z.object({ items: z.array(z.object({
  resource: remoteReferenceSchema, title: z.string().optional(),
})) });
