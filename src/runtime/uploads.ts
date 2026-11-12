import { join } from 'node:path';
import { z } from 'zod';
import type { AccountIdentity } from '../core/types.js';
import type { Artifact, UploadReuse, UploadReceipt } from '../core/content.js';
import { semanticDigest } from './objects.js';
import { readJson, writeJson } from './storage.js';
import { CliError } from '../shared/errors.js';

// Cache failures carry no workflow outcome: a composing handler may already have written remotely.
// The caller holds the real account lock; cache files are only reusable projections, never write receipts.
export class UploadCache implements UploadReuse {
  constructor(readonly home: string, readonly identity: AccountIdentity, readonly warn: (reason: string) => void) {}
  async use<T>(artifact: Artifact, purpose: string, protocol: string, schema: z.ZodType<T>, hooks: {
    upload(): Promise<UploadReceipt<T>>; revalidate(value: T): Promise<UploadReceipt<T> | undefined>;
  }): Promise<T> {
    const key = semanticDigest({ identity: this.identity, artifact, purpose, protocol });
    const file = join(this.home, 'cache', 'uploads', key + '.json');
    const storedSchema = z.object({ key: z.literal(key), value: schema, expiresAt: z.number().optional() });
    let stored: unknown;
    try { stored = await readJson(file); }
    catch (error) { throw new CliError('INPUT', '无法读取素材缓存，请先修复本地文件。', { reason: 'upload_cache_read_failed', file, cause: error instanceof Error ? error.message : String(error) }); }
    let receipt: UploadReceipt<T> | undefined;
    if (stored !== undefined) {
      const decoded = storedSchema.safeParse(stored);
      if (!decoded.success) throw new CliError('INPUT', '素材缓存格式损坏，请修复或移除该缓存。', { reason: 'upload_cache_invalid', file });
      const cached = decoded.data;
      if (cached.expiresAt !== undefined && cached.expiresAt > Date.now()) receipt = cached;
      else receipt = await hooks.revalidate(cached.value);
    }
    receipt ??= await hooks.upload();
    try { await writeJson(file, { key, ...receipt }); }
    catch { this.warn('upload_cache_write_failed'); }
    return receipt.value;
  }
}
