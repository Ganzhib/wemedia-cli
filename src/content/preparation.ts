import { readFile } from 'node:fs/promises';
import { extname, resolve, join } from 'node:path';
import type { Artifact, ContentRevision, PreparedVariant } from '../core/content.js';
import { ObjectStore, canonicalJson, semanticDigest } from '../runtime/objects.js';
import { readJson, writeJson, withFileLock } from '../runtime/storage.js';

// One preparation batch shares captured bytes, so later targets never reread a changed source.
export class PreparationContext {
  private readonly sources: Artifact[] = [];
  private readonly assets: Artifact[] = [];
  private importer = 'json';
  private metadata: unknown = null;
  readonly objects: ObjectStore;
  constructor(readonly home: string, private readonly files = new Map<string, Promise<Artifact>>()) { this.objects = new ObjectStore(home); }
  fork(): PreparationContext { return new PreparationContext(this.home, this.files); }
  async capture(file: string, mediaType: string): Promise<Artifact> {
    const absolute = resolve(file);
    let captured = this.files.get(absolute);
    if (!captured) {
      const extension = extname(absolute).toLowerCase();
      captured = readFile(absolute).then(bytes => this.objects.put(bytes, mediaType, /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : ''));
      this.files.set(absolute, captured);
    }
    return captured;
  }
  source(artifact: Artifact, importer: string, metadata: unknown): void { this.sources.push(artifact); this.importer = importer; this.metadata = metadata; }
  asset(artifact: Artifact): void { if (!this.assets.some(entry => entry.digest === artifact.digest && entry.extension === artifact.extension)) this.assets.push(artifact); }
  async freeze(payload: unknown, renderer: PreparedVariant['renderer']): Promise<PreparedVariant> {
    const encoded = canonicalJson(payload);
    const content = await this.objects.put(Buffer.from(encoded), 'application/json', '.json');
    const revisionInput = {
      importer: this.importer, sources: this.sources.length ? this.sources : [content],
      assets: [...this.assets].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))), metadata: this.metadata,
    };
    const revision = { schema: 1, id: semanticDigest(revisionInput), ...revisionInput } as ContentRevision;
    const variantInput = { revisionId: revision.id, digest: content.digest, payload: content, artifacts: [...revision.sources, ...revision.assets], renderer };
    const variant: PreparedVariant = { schema: 1, id: semanticDigest(variantInput), ...variantInput };
    await immutableJson(this.home, 'revisions', revision.id, revision);
    await immutableJson(this.home, 'variants', variant.id, variant);
    return variant;
  }
}

export function immutableJson<T>(home: string, directory: string, id: string, value: T): Promise<T> {
  return withFileLock(join(home, directory, id + '.lock'), async () => {
    const file = join(home, directory, id + '.json');
    const existing = await readJson<T>(file);
    if (existing !== undefined) return existing;
    await writeJson(file, value);
    return value;
  });
}
