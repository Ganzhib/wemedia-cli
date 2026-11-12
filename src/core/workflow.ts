import { z } from 'zod';
import type { CapabilityContext } from './types.js';
import { parseInput } from './validation.js';

export const workflowStepSchema = z.object({
  id: z.string().min(1), handler: z.string().min(1), version: z.string().min(1),
  needs: z.array(z.string()), input: z.json(),
});
export const workflowSchema = z.object({
  id: z.string().min(1), version: z.string().min(1), steps: z.array(workflowStepSchema).min(1), resultStep: z.string(),
});
export type CompiledWorkflow = z.infer<typeof workflowSchema>;
export interface StepHandler<S> {
  version: string; effect: 'read' | 'remote-write';
  inputSchema: z.ZodType; dependencySchema: z.ZodType; outputSchema: z.ZodType;
  execute(context: CapabilityContext<S>, input: unknown, dependencies: unknown): Promise<unknown>;
}
export function stepHandler<S>() {
  return <I, D, O>(definition: {
    version: string; effect: StepHandler<S>['effect']; input: z.ZodType<I>; dependencies: z.ZodType<D>; output: z.ZodType<O>;
    execute(context: CapabilityContext<S>, input: NoInfer<I>, dependencies: NoInfer<D>): Promise<NoInfer<O>>;
  }): StepHandler<S> => ({
    version: definition.version, effect: definition.effect, inputSchema: definition.input,
    dependencySchema: definition.dependencies, outputSchema: definition.output,
    // Step inputs are decoded at the execution boundary, including dependencies restored from durable records.
    execute: (context, input, dependencies) => definition.execute(context, parseInput(definition.input, input), parseInput(definition.dependencies, dependencies)),
  });
}
export function validateWorkflow<S>(workflow: CompiledWorkflow, handlers: ReadonlyMap<string, StepHandler<S>>): void {
  const completed = new Set<string>();
  for (const step of workflow.steps) {
    const handler = handlers.get(step.handler);
    if (!handler || handler.version !== step.version || completed.has(step.id) || step.needs.some(id => !completed.has(id))) throw new Error('Invalid workflow step: ' + step.id);
    completed.add(step.id);
  }
  if (!completed.has(workflow.resultStep) || workflow.steps.at(-1)!.id !== workflow.resultStep) throw new Error('Workflow result must be its final step');
}
