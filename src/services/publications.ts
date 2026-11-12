import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { OperationRecord } from './operations.js';
import { OperationRepository } from './operations.js';
import { writeJson } from '../runtime/storage.js';
import { digestSchema } from '../core/content.js';
import { parseInput } from '../core/validation.js';
import { CliError } from '../shared/errors.js';

export interface Publication {
  id: string; operationId: string; identity: OperationRecord['target']['identity'];
  capabilityId: string; revisionId: string; variantId: string;
  references: OperationRecord['references']; result?: OperationRecord['result'];
  observation?: OperationRecord['observations'][number];
}
export class PublicationService {
  readonly operations: OperationRepository;
  constructor(readonly home: string) { this.operations = new OperationRepository(home); }
  private root() { return join(this.home, 'indexes', 'publications'); }
  derive(record: OperationRecord): Publication | undefined {
    const references = [...record.references];
    if (record.result?.remote && !references.some(reference => JSON.stringify(reference) === JSON.stringify(record.result!.remote))) references.push(record.result.remote);
    if (!references.length) return undefined;
    return { id: record.id, operationId: record.id, identity: record.target.identity, capabilityId: record.capabilityId,
      revisionId: record.target.revisionId, variantId: record.target.variantId, references, result: record.result, observation: record.observations.at(-1) };
  }
  async update(record: OperationRecord): Promise<void> {
    const publication = this.derive(record);
    if (publication) await writeJson(join(this.root(), publication.id + '.json'), publication);
  }
  async get(id: string): Promise<Publication> {
    parseInput(digestSchema, id);
    const record = await this.operations.find(id);
    const publication = record && this.derive(record);
    if (!publication) throw new CliError('INPUT', '找不到本地内容记录。');
    return publication;
  }
  async list(): Promise<Publication[]> {
    let files;
    try { files = await readdir(this.root()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const file of files.filter(file => file.endsWith('.json'))) {
      // An index only supplies IDs; current facts are always derived from their authoritative operations.
      const id = file.slice(0, -5); result.push(await this.get(id));
    }
    return result;
  }
  async rebuild(): Promise<Publication[]> {
    let files;
    try { files = await readdir(join(this.home, 'operations')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    await rm(this.root(), { recursive: true, force: true });
    const publications = [];
    for (const file of files.filter(file => file.endsWith('.json'))) {
      const record = (await this.operations.find(file.slice(0, -5)))!;
      const publication = this.derive(record);
      if (publication) { await this.update(record); publications.push(publication); }
    }
    return publications;
  }
}
