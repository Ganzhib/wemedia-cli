import { join } from 'node:path';
import { z } from 'zod';
import { operationResultSchema, remoteReferenceSchema } from '../core/types.js';
import type { OperationContext } from '../core/types.js';
import type { WriteCapability } from '../core/capability.js';
import type { PlatformSession } from '../core/platform.js';
import { parseInput } from '../core/validation.js';
import { workflowSchema } from '../core/workflow.js';
import { readJson, writeJson, withFileLock } from '../runtime/storage.js';
import { semanticDigest } from '../runtime/objects.js';
import type { PublishPlan, PlanTarget } from './planning.js';
import { planTargetSchema } from './planning.js';
import { CliError } from '../shared/errors.js';

export const stepRecordSchema = z.object({
  phase: z.enum(['ready', 'running', 'succeeded', 'rejected', 'unknown', 'waiting_for_verification']),
  value: z.json().optional(), message: z.string().optional(),
});
export type StepRecord = z.infer<typeof stepRecordSchema>;
const operationSchema = z.object({
  schema: z.literal(1), id: z.string(), capabilityId: z.string(), copyNonce: z.string(), createdAt: z.string(),
  target: planTargetSchema, workflow: workflowSchema,
  steps: z.record(z.string(), stepRecordSchema), references: z.array(remoteReferenceSchema),
  status: z.enum(['planned', 'running', 'rejected', 'unknown', 'waiting_for_verification', 'completed']),
  result: operationResultSchema.optional(), observations: z.array(z.object({ time: z.string(), result: operationResultSchema })),
  message: z.string().optional(),
});
export type OperationRecord = z.infer<typeof operationSchema>;
export function operationId(plan: PublishPlan, target: PlanTarget): string {
  return semanticDigest({ identity: target.identity, capabilityId: plan.capabilityId, revisionId: target.revisionId, contentDigest: target.contentDigest, copyNonce: plan.copyNonce });
}
export class OperationRepository {
  constructor(readonly home: string) {}
  file(id: string): string { return join(this.home, 'operations', id + '.json'); }
  async find(id: string): Promise<OperationRecord | undefined> {
    const stored = await readJson(this.file(id));
    if (!stored) return undefined;
    const operation = parseInput(operationSchema, stored);
    if (operation.id !== id) throw new CliError('INPUT', '操作记录 ID 不匹配。');
    return operation;
  }
  save(record: OperationRecord): Promise<void> { return writeJson(this.file(record.id), record); }
  use<T>(plan: PublishPlan, target: PlanTarget, action: (record: OperationRecord) => Promise<T>): Promise<T> {
    const id = operationId(plan, target);
    return withFileLock(join(this.home, 'operations', id + '.lock'), async () => {
      let record = await this.find(id);
      if (!record) {
        record = { schema: 1, id, capabilityId: plan.capabilityId, copyNonce: plan.copyNonce, createdAt: new Date().toISOString(), target, workflow: target.workflow,
          steps: {}, references: [], status: 'planned', observations: [] };
        await this.save(record);
      }
      return action(record);
    });
  }
}
export class WorkflowExecutor {
  constructor(readonly operations: OperationRepository) {}
  async run(record: OperationRecord, capability: WriteCapability<never>, session: PlatformSession, context: OperationContext): Promise<void> {
    for (const step of record.workflow.steps) {
      const previous = record.steps[step.id];
      if (previous?.phase === 'succeeded') continue;
      const handler = capability.handlers.get(step.handler)!;
      if (handler.effect === 'remote-write' && previous && ['running', 'unknown', 'waiting_for_verification'].includes(previous.phase)) {
        record.status = previous.phase === 'waiting_for_verification' ? previous.phase : 'unknown';
        record.message = '存在未确认的写入，先回查，不能重发。'; await this.operations.save(record); return;
      }
      const dependencies = Object.fromEntries(step.needs.map(id => [id, record.steps[id].value]));
      record.steps[step.id] = { phase: 'running' }; record.status = 'running';
      await this.operations.save(record);
      let value: unknown;
      try { value = await session.executeStep(record.capabilityId, step.handler, step.input, dependencies, context); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let phase: StepRecord['phase'] = handler.effect === 'read' ? 'rejected' : 'unknown';
        if (error instanceof CliError && error.details?.outcome === 'rejected') phase = 'rejected';
        if (error instanceof CliError && error.code === 'VERIFICATION') phase = 'waiting_for_verification';
        record.steps[step.id] = { phase, message }; record.status = phase; record.message = message;
        await this.operations.save(record); return;
      }
      record.steps[step.id] = { phase: 'succeeded', value: JSON.parse(JSON.stringify(value)) };
      if (step.id === record.workflow.resultStep) {
        record.result = parseInput(capability.outputSchema, value) as z.infer<typeof operationResultSchema>;
        record.status = 'completed'; delete record.message;
        if (record.result.status === 'rejected' || record.result.status === 'waiting_for_verification' || record.result.status === 'unknown') {
          record.status = record.result.status; record.steps[step.id].phase = record.result.status; record.message = record.result.message;
        }
      }
      // This record is the authority. Projections and event logs are updated only after it commits.
      await this.operations.save(record);
    }
  }
}
