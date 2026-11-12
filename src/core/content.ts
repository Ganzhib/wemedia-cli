import { z } from 'zod';

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const artifactSchema = z.object({
  digest: digestSchema, size: z.int().nonnegative(), mediaType: z.string().min(1),
  extension: z.string().regex(/^(\.[a-z0-9]{1,16})?$/),
});
export type Artifact = z.infer<typeof artifactSchema>;
export interface ArtifactReader { path(artifact: Artifact): string; read(artifact: Artifact): Promise<Buffer>; verify(artifact: Artifact): Promise<void> }
export interface ArtifactStore extends ArtifactReader { put(bytes: Uint8Array, mediaType: string, extension?: string): Promise<Artifact> }
export interface ContentPreparation {
  objects: ArtifactStore;
  capture(file: string, mediaType: string): Promise<Artifact>;
  source(artifact: Artifact, importer: string, metadata: unknown): void;
  asset(artifact: Artifact): void;
  output(bytes: Uint8Array, mediaType: string, role: string, extension?: string): Promise<Artifact>;
}
export const revisionSchema = z.object({
  schema: z.literal(1), id: digestSchema, importer: z.string(),
  sources: z.array(artifactSchema), assets: z.array(artifactSchema), metadata: z.json(),
});
export type ContentRevision = z.infer<typeof revisionSchema>;
export const variantSchema = z.object({
  schema: z.literal(2), id: digestSchema, revisionId: digestSchema, digest: digestSchema,
  payload: artifactSchema, outputs: z.array(z.object({ role: z.string(), artifact: artifactSchema })), artifacts: z.array(artifactSchema), renderer: z.object({ id: z.string(), version: z.string() }),
});
export type PreparedVariant = z.infer<typeof variantSchema>;

export interface UploadReceipt<T> { value: T; expiresAt?: number }
export interface UploadReuse {
  use<T>(artifact: Artifact, purpose: string, protocol: string, schema: z.ZodType<T>, hooks: {
    upload(): Promise<UploadReceipt<T>>; revalidate(value: T): Promise<UploadReceipt<T> | undefined>;
  }): Promise<T>;
}
