import { z } from 'zod';
import type { CapabilityAvailability, CapabilityContext, CapabilityMetadata, OperationResult, RemoteReference } from './types.js';
import { CliError } from '../shared/errors.js';

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CliError('INPUT', '输入不符合能力契约。', {
    issues: result.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
  });
  return result.data;
}

interface BaseCapability<S> extends CapabilityMetadata {
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  preparedSchema: z.ZodType;
  prepare(input: unknown): Promise<unknown>;
  preflight(prepared: unknown): Promise<void>;
  probe(session: S): Promise<CapabilityAvailability>;
}
export interface ReadCapability<S> extends BaseCapability<S> {
  effect: 'read'; execute(context: CapabilityContext<S>, prepared: unknown): Promise<unknown>;
}
export interface WriteCapability<S> extends BaseCapability<S> {
  successStates: readonly OperationResult['status'][];
  effect: 'remote-write'; execute(context: CapabilityContext<S>, prepared: unknown): Promise<OperationResult>;
  inspect?(context: CapabilityContext<S>, remote: RemoteReference, prepared: unknown): Promise<OperationResult>;
}
export type Capability<S> = ReadCapability<S> | WriteCapability<S>;
const unknownAvailability = async (): Promise<CapabilityAvailability> => ({ state: 'unknown', reason: '已验证身份；实际权限由操作的前置检查确定。' });

export function readCapability<S>() {
  return <I, O>(definition: CapabilityMetadata & {
    input: z.ZodType<I>; output: z.ZodType<O>;
    probe?: (session: S) => Promise<CapabilityAvailability>;
    execute(context: Pick<CapabilityContext<S>, 'account' | 'session'>, input: NoInfer<I>): Promise<NoInfer<O>>;
  }): ReadCapability<S> => ({
    ...definition, effect: 'read', inputSchema: definition.input, outputSchema: definition.output, preparedSchema: definition.input,
    prepare: async input => parseInput(definition.input, input), preflight: async () => undefined,
    probe: definition.probe ?? unknownAvailability,
    // Input and persisted prepared data are validated at their boundaries; handlers share the inferred type.
    execute: (context, prepared) => definition.execute(context, prepared as I),
  });
}

export function writeCapability<S>() {
  return <I, P, O extends OperationResult>(definition: CapabilityMetadata & {
    input: z.ZodType<I>; prepared: z.ZodType<P>; output: z.ZodType<O>;
    successStates: readonly OperationResult['status'][];
    prepare(input: NoInfer<I>): Promise<NoInfer<P>>;
    preflight(prepared: NoInfer<P>): Promise<void>;
    probe?: (session: S) => Promise<CapabilityAvailability>;
    execute(context: CapabilityContext<S>, prepared: NoInfer<P>): Promise<NoInfer<O>>;
    inspect?(context: CapabilityContext<S>, remote: RemoteReference, prepared: NoInfer<P>): Promise<OperationResult>;
  }): WriteCapability<S> => ({
    ...definition, effect: 'remote-write', inputSchema: definition.input, outputSchema: definition.output, preparedSchema: definition.prepared,
    prepare: raw => definition.prepare(parseInput(definition.input, raw)),
    probe: definition.probe ?? unknownAvailability,
    preflight: prepared => definition.preflight(prepared as P),
    execute: (context, prepared) => definition.execute(context, prepared as P),
    ...(definition.inspect ? { inspect: (context: CapabilityContext<S>, remote: RemoteReference, prepared: unknown) => definition.inspect!(context, remote, prepared as P) } : {}),
  });
}
