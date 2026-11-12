import { Command } from 'commander';
import { resolve } from 'node:path';
import { JuejinClient } from '../platform/juejin/client.js';
import { JuejinHttp } from '../platform/juejin/http.js';
import { ImageUploader } from '../platform/juejin/imagex.js';
import { SessionStore, cookieHeader } from '../platform/juejin/session.js';
import { DraftService } from '../platform/juejin/draft-service.js';
import { WritingService } from '../platform/juejin/writing-service.js';
import { CliOutput } from './output.js';
import { withBrowserHttp } from '../platform/juejin/browser-http.js';
import type { Globals } from './options.js';

export interface CommandServices {
  session: SessionStore;
  client: JuejinClient;
  uploader: ImageUploader;
  writing: WritingService;
}
export type ServiceFactory = (session: SessionStore, authenticated: boolean) => Promise<CommandServices>;

export type GrowthServiceRunner = <T>(session: SessionStore, action: (services: CommandServices) => Promise<T>, page?: 'signin' | 'lottery') => Promise<T>;

function servicesFromHttp(session: SessionStore, http: JuejinHttp): CommandServices {
  const client = new JuejinClient(http);
  const uploader = new ImageUploader(http);
  const drafts = new DraftService(client, uploader);
  return { session, client, uploader, writing: new WritingService(client, uploader, session, drafts) };
}

export const runGrowthServices: GrowthServiceRunner = (session, action, page) =>
  withBrowserHttp(session, http => action(servicesFromHttp(session, http)), page);

export async function createServices(session: SessionStore, authenticated: boolean): Promise<CommandServices> {
  const cookies = authenticated ? await session.load() : [];
  const http = new JuejinHttp({ cookie: cookieHeader(cookies) });
  return servicesFromHttp(session, http);
}

export class CommandContext {
  constructor(
    readonly program: Command,
    readonly output: CliOutput,
    private readonly serviceFactory: ServiceFactory = createServices,
    private readonly growthRunner: GrowthServiceRunner = runGrowthServices,
  ) {}

  globals(): Globals { return this.program.opts<Globals>(); }
  session(): SessionStore { return new SessionStore(resolve(this.globals().home)); }
  services(authenticated = false): Promise<CommandServices> { return this.serviceFactory(this.session(), authenticated); }
  growth<T>(action: (services: CommandServices) => Promise<T>, page: 'signin' | 'lottery' = 'signin'): Promise<T> { return this.growthRunner(this.session(), action, page); }
  emit(value: unknown): void { this.output.success(value, this.globals().json === true); }
}
