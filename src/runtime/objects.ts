import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact, ArtifactReader } from '../core/content.js';
import { CliError } from '../shared/errors.js';

export function digest(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) return Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]));
    return entry;
  });
}
export function semanticDigest(value: unknown): string { return digest(canonicalJson(value)); }

export class ObjectStore implements ArtifactReader {
  constructor(readonly home: string) {}
  path(artifact: Artifact): string { return join(this.home, 'objects', artifact.digest + artifact.extension); }
  async put(bytes: Uint8Array, mediaType: string, extension = ''): Promise<Artifact> {
    const artifact = { digest: digest(bytes), size: bytes.length, mediaType, extension };
    await mkdir(join(this.home, 'objects'), { recursive: true, mode: 0o700 });
    const temporary = join(this.home, 'objects', randomUUID() + '.tmp');
    const file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      // Publish only complete bytes. Concurrent importers can safely observe an existing object.
      try { await link(temporary, this.path(artifact)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.verify(artifact);
      }
    } finally { await rm(temporary, { force: true }); }
    return artifact;
  }
  async read(artifact: Artifact): Promise<Buffer> {
    const bytes = await readFile(this.path(artifact));
    if (bytes.length !== artifact.size || digest(bytes) !== artifact.digest) throw new CliError('INPUT', '内容快照缺失或损坏，停止执行。', { digest: artifact.digest });
    return bytes;
  }
  async verify(artifact: Artifact): Promise<void> { await this.read(artifact); }
}
