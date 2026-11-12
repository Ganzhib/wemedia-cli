import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountIdentity, RemoteReference, ResourceSnapshot } from '../core/types.js';
import type { OperationRecord } from './operations.js';
import { OperationRepository } from './operations.js';
import { writeJson, withFileLock } from '../runtime/storage.js';
import { semanticDigest } from '../runtime/objects.js';
import { digestSchema } from '../core/content.js';
import { parseInput } from '../core/validation.js';
import { CliError } from '../shared/errors.js';

export interface Publication {
  id: string; identity: AccountIdentity; references: RemoteReference[];
  revisions: { operationId: string; capabilityId: string; revisionId: string; variantId: string; time: string; result?: OperationRecord['result'] }[];
  observation?: OperationRecord['observations'][number];
}
function referenceKey(identity: AccountIdentity, reference: RemoteReference) {
  return semanticDigest({ identity, kind: reference.kind, id: reference.id, selector: reference.selector });
}
function references(record: OperationRecord): RemoteReference[] {
  const all = [...record.references];
  if (record.result?.remote) all.push(record.result.remote);
  return [...new Map(all.map(reference => [referenceKey(record.target.identity, reference), reference])).values()];
}
export class PublicationService {
  readonly operations: OperationRepository;
  constructor(readonly home: string) { this.operations = new OperationRepository(home); }
  private root() { return join(this.home, 'indexes', 'publications'); }
  private async records(): Promise<OperationRecord[]> {
    let files;
    try { files = await readdir(join(this.home, 'operations')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const file of files.filter(file => file.endsWith('.json'))) records.push((await this.operations.find(file.slice(0, -5)))!);
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async list(): Promise<Publication[]> {
    // Draft creation, updates and publication form one lineage through exact resource references.
    // Titles and URLs never establish identity; assets are recorded separately by the executor.
    const groups: { records: OperationRecord[]; references: Map<string, RemoteReference> }[] = [];
    for (const record of await this.records()) {
      const remote = references(record); if (!remote.length) continue;
      const keys = remote.map(reference => referenceKey(record.target.identity, reference));
      const matches = groups.filter(group => keys.some(key => group.references.has(key)));
      const group = matches[0] ?? { records: [], references: new Map<string, RemoteReference>() };
      if (!matches.length) groups.push(group);
      for (const merged of matches.slice(1)) {
        group.records.push(...merged.records);
        for (const [key, reference] of merged.references) group.references.set(key, reference);
        groups.splice(groups.indexOf(merged), 1);
      }
      group.records.push(record);
      remote.forEach((reference, index) => group.references.set(keys[index], reference));
    }
    return groups.map(group => {
      group.records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const first = group.records[0]; const anchor = references(first)[0];
      const observations = group.records.flatMap(record => record.observations).sort((a, b) => a.time.localeCompare(b.time));
      return { id: referenceKey(first.target.identity, anchor), identity: first.target.identity, references: [...group.references.values()],
        revisions: group.records.map(record => ({ operationId: record.id, capabilityId: record.capabilityId, revisionId: record.target.revisionId, variantId: record.target.variantId, time: record.createdAt, result: record.result })), observation: observations.at(-1) };
    });
  }
  async update(_record: OperationRecord): Promise<void> {
    // The index is expendable; all queries derive facts from authoritative operation records.
    for (const publication of await this.list()) await writeJson(join(this.root(), publication.id + '.json'), publication);
  }
  async get(id: string): Promise<Publication> {
    parseInput(digestSchema, id);
    const publication = (await this.list()).find(publication => publication.id === id);
    if (!publication) throw new CliError('INPUT', '找不到本地内容记录。');
    return publication;
  }
  async refresh(id: string, read: (identity: AccountIdentity, reference: RemoteReference) => Promise<ResourceSnapshot>): Promise<Publication> {
    const publication = await this.get(id); const latest = publication.revisions.at(-1)!;
    let observation: OperationRecord['observations'][number];
    try {
      const snapshot = await read(publication.identity, publication.references.at(-1)!);
      observation = { time: new Date().toISOString(), result: { state: snapshot.state, remote: snapshot.resource, snapshot } };
    } catch (error) {
      observation = { time: new Date().toISOString(), error: { code: error instanceof CliError ? error.code : 'INTERNAL', message: error instanceof Error ? error.message : String(error) } };
    }
    await withFileLock(join(this.home, 'operations', latest.operationId + '.lock'), async () => {
      const record = (await this.operations.find(latest.operationId))!;
      record.observations.push(observation); await this.operations.save(record);
    });
    return this.get(id);
  }
  async rebuild(): Promise<Publication[]> {
    await rm(this.root(), { recursive: true, force: true }); await mkdir(this.root(), { recursive: true });
    const publications = await this.list();
    for (const publication of publications) await writeJson(join(this.root(), publication.id + '.json'), publication);
    return publications;
  }
}
