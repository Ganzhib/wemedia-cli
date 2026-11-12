import { z } from 'zod';
import type { ArtifactReader } from './content.js';

export const accountProfileSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });
export type AccountProfile = z.infer<typeof accountProfileSchema>;
export const accountIdentitySchema = z.object({
  bindingId: z.string().regex(/^[a-f0-9]{32}$/), platformId: z.string().min(1), accountId: z.string().min(1),
});
export type AccountIdentity = z.infer<typeof accountIdentitySchema>;
export const accountBindingSchema = z.object({
  schema: z.literal(2), identity: accountIdentitySchema, name: z.string(), sessionId: z.uuid(),
});
export type AccountBinding = z.infer<typeof accountBindingSchema>;
export interface AccountScope { identity: AccountIdentity; directory: string }

export const remoteReferenceSchema = z.object({
  kind: z.string().min(1), id: z.string().min(1), url: z.string().optional(),
  selector: z.record(z.string(), z.string()).optional(),
});
export type RemoteReference = z.infer<typeof remoteReferenceSchema>;
export const outcomeSchema = z.enum(['completed', 'draft_saved', 'submitted', 'published', 'rejected', 'unknown', 'waiting_for_verification']);
export const operationResultSchema = z.object({
  status: outcomeSchema, remote: remoteReferenceSchema.optional(), message: z.string().optional(), data: z.json().optional(),
});
export type OperationResult = z.infer<typeof operationResultSchema>;
export interface OperationContext {
  account: AccountScope;
  artifacts: ArtifactReader;
  remember(remote: RemoteReference): Promise<void>;
}
export interface CapabilityContext<S> extends OperationContext { session: S }
export interface CapabilityAvailability {
  state: 'available' | 'unavailable' | 'unknown'; reason: string;
}
export interface CapabilityMetadata {
  id: string; description: string;
  acceptance: { offline: boolean; liveRead: boolean; liveWrite: boolean };
}
export interface SessionProfile { profile: AccountProfile }
