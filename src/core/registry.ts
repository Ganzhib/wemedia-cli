import { z } from 'zod';
import type { Platform } from './platform.js';
import { CliError } from '../shared/errors.js';

export class PlatformRegistry {
  private readonly platforms = new Map<string, Platform>();
  constructor(platforms: Platform[]) {
    for (const platform of platforms) {
      if (this.platforms.has(platform.id)) throw new Error('Duplicate platform: ' + platform.id);
      this.platforms.set(platform.id, platform);
    }
  }
  get(id: string): Platform {
    const platform = this.platforms.get(id);
    if (!platform) throw new CliError('INPUT', '未知平台：' + id, { platforms: [...this.platforms.keys()] });
    return platform;
  }
  capability(platformId: string, capabilityId: string) {
    const capability = this.get(platformId).capabilities.get(capabilityId);
    if (!capability) throw new CliError('UNSUPPORTED', '平台未实现此能力：' + capabilityId);
    return capability;
  }
  describe(platformId?: string) {
    const platforms = platformId ? [this.get(platformId)] : [...this.platforms.values()];
    return platforms.map(platform => ({
      id: platform.id, name: platform.name, driver: platform.driver,
      capabilities: [...platform.capabilities.values()].map(capability => ({
        id: capability.id, description: capability.description, effect: capability.effect, acceptance: capability.acceptance,
        input_schema: z.toJSONSchema(capability.inputSchema, { io: 'input' }), output_schema: z.toJSONSchema(capability.outputSchema),
      })),
    }));
  }
}
