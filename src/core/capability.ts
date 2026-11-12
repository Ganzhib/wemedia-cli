import { z } from 'zod';
import type { CapabilityAvailability, CapabilityContext, CapabilityMetadata, OperationResult, RemoteReference } from './types.js';
import type { ContentPreparation, ArtifactReader } from './content.js';
import { parseInput } from './validation.js';
import { stepHandler, validateWorkflow, type StepHandler, type CompiledWorkflow } from './workflow.js';

interface BaseCapability<S> extends CapabilityMetadata {
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  preparedSchema: z.ZodType;
  prepare(input: unknown, context: ContentPreparation): Promise<unknown>;
  preflight(prepared: unknown, artifacts: ArtifactReader): Promise<void>;
  probe(session: S): Promise<CapabilityAvailability>;
}
export interface ReadCapability<S> extends BaseCapability<S> {
  effect: 'read'; execute(context: CapabilityContext<S>, prepared: unknown): Promise<unknown>;
}
export interface WriteCapability<S> extends BaseCapability<S> {
  successStates: readonly OperationResult['status'][];
  effect: 'remote-write';
  handlers: ReadonlyMap<string, StepHandler<S>>;
  compile(prepared: unknown): CompiledWorkflow;
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

interface WriteDefinition<S, I, P, O extends OperationResult> extends CapabilityMetadata {
  input: z.ZodType<I>; prepared: z.ZodType<P>; output: z.ZodType<O>;
  successStates: readonly OperationResult['status'][];
  prepare(input: NoInfer<I>, context: ContentPreparation): Promise<NoInfer<P>>;
  preflight(prepared: NoInfer<P>, artifacts: ArtifactReader): Promise<void>;
  probe?: (session: S) => Promise<CapabilityAvailability>;
  inspect?(context: CapabilityContext<S>, remote: RemoteReference, prepared: NoInfer<P>): Promise<OperationResult>;
}
export function workflowCapability<S>() {
  return <I, P, O extends OperationResult>(definition: WriteDefinition<S, I, P, O> & {
    compile(prepared: NoInfer<P>): CompiledWorkflow;
    handlers: Record<string, StepHandler<S>>;
  }): WriteCapability<S> => {
    const handlers = new Map(Object.entries(definition.handlers));
    return {
      ...definition, handlers, effect: 'remote-write', inputSchema: definition.input, outputSchema: definition.output, preparedSchema: definition.prepared,
      prepare: (raw, context) => definition.prepare(parseInput(definition.input, raw), context),
      probe: definition.probe ?? unknownAvailability,
      preflight: (prepared, artifacts) => definition.preflight(prepared as P, artifacts),
      compile: prepared => { const workflow = definition.compile(prepared as P); validateWorkflow(workflow, handlers); return workflow; },
      ...(definition.inspect ? { inspect: (context: CapabilityContext<S>, remote: RemoteReference, prepared: unknown) => definition.inspect!(context, remote, prepared as P) } : {}),
    };
  };
}

// A direct write is a one-step workflow; composite drivers declare their actual dependencies.
export function writeCapability<S>() {
  return <I, P, O extends OperationResult>(definition: WriteDefinition<S, I, P, O> & {
    execute(context: CapabilityContext<S>, prepared: NoInfer<P>): Promise<NoInfer<O>>;
  }): WriteCapability<S> => workflowCapability<S>()({
    ...definition,
    compile: prepared => ({ id: definition.id, version: '1', resultStep: 'capability.execute', steps: [
      { id: 'capability.execute', handler: 'execute', version: '1', needs: [], input: JSON.parse(JSON.stringify(prepared)) },
    ] }),
    handlers: { execute: stepHandler<S>()({
      version: '1', effect: 'remote-write', input: definition.prepared, dependencies: z.strictObject({}), output: definition.output,
      execute: (context, input) => definition.execute(context, input),
    }) },
  });
}
