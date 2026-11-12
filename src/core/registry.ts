import type { PlatformAdapter } from './types.js';
import { CliError } from '../shared/errors.js';

export class PlatformRegistry {
  private readonly adapters = new Map<string, PlatformAdapter>();

  constructor(platforms: PlatformAdapter[]) {
    for (const platform of platforms) {
      if (this.adapters.has(platform.id)) throw new Error('Duplicate platform: ' + platform.id);
      this.adapters.set(platform.id, platform);
    }
  }

  get(id: string): PlatformAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new CliError('INPUT', '未知平台：' + id, { platforms: [...this.adapters.keys()] });
    return adapter;
  }

  describe() {
    return [...this.adapters.values()].map(adapter => ({
      id: adapter.id, name: adapter.name, driver: adapter.driver, version: adapter.version,
      operations: Object.entries(adapter.operations).map(([id, operation]) => ({ id, description: operation.description })),
      lists: Object.entries(adapter.lists).map(([id, query]) => ({ id, description: query.description })),
    }));
  }
}
