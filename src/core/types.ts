import type { AccountStore } from '../runtime/accounts.js';

export type Intent = 'draft' | 'publish';
export interface AccountProfile { id: string; name: string }
export interface Asset { source: string; path?: string; digest?: string; size?: number }
export interface ArticleDocument {
  file: string;
  sourceDigest: string;
  markdown: string;
  metadata: Record<string, unknown>;
  platforms: Record<string, Record<string, unknown>>;
}
export interface PreparedArticle {
  title: string;
  body: string;
  format: 'markdown' | 'html' | 'image-text';
  assets: Asset[];
  cover?: Asset;
  options: Record<string, unknown>;
}
export interface RemoteReference {
  kind: 'draft' | 'article' | 'submission';
  id?: string;
  url?: string;
}
export type Outcome = 'draft_saved' | 'submitted' | 'published' | 'rejected' | 'unknown' | 'waiting_for_verification';
export interface OperationResult {
  status: Outcome;
  remote?: RemoteReference;
  message?: string;
}
export interface OperationContext {
  account: AccountStore;
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
  remember(remote: RemoteReference): Promise<void>;
}
export interface PlatformOperation {
  description: string;
  run(context: OperationContext, article: PreparedArticle): Promise<OperationResult>;
}
export interface PlatformQuery {
  description: string;
  run(account: AccountStore, limit: number): Promise<unknown>;
}
export interface PlatformAdapter {
  id: string;
  name: string;
  driver: string;
  version: string;
  operations: Partial<Record<Intent, PlatformOperation>>;
  lists: Partial<Record<'draft' | 'article', PlatformQuery>>;
  prepare(document: ArticleDocument, options: Record<string, unknown>): Promise<PreparedArticle>;
  login(account: AccountStore): Promise<AccountProfile>;
  status(account: AccountStore): Promise<AccountProfile>;
  inspect?(account: AccountStore, remote: RemoteReference, expected?: PreparedArticle): Promise<OperationResult>;
}
