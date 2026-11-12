import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { operationResultSchema, remoteReferenceSchema, remoteObservationSchema } from '../core/types.js';
import type { OperationContext, OperationResult } from '../core/types.js';
import type { WriteCapability } from '../core/capability.js';
import type { PlatformSession } from '../core/platform.js';
import { parseInput } from '../core/validation.js';
import { workflowSchema, verificationSchema } from '../core/workflow.js';
import { readJson, writeJson, withFileLock } from '../runtime/storage.js';
import { semanticDigest } from '../runtime/objects.js';
import type { PublishPlan, PlanTarget } from './planning.js';
import { planTargetSchema } from './planning.js';
import { CliError } from '../shared/errors.js';

export const stepRecordSchema = z.object({
  phase: z.enum(['ready', 'running', 'succeeded', 'rejected', 'unknown', 'waiting_for_verification']),
  failure: z.object({ code: z.string(), details: z.json().optional() }).optional(),
  value: z.json().optional(), message: z.string().optional(), references: z.array(remoteReferenceSchema), verification: verificationSchema.optional(),
  recovery: z.object({ time: z.string(), verdict: z.enum(['effect_confirmed', 'not_applied', 'indeterminate']), source: z.string(), message: z.string(), reference: remoteReferenceSchema.optional() }).optional(),
});
export type StepRecord = z.infer<typeof stepRecordSchema>;
const operationSchema = z.object({
  schema: z.literal(3), id: z.string(), capabilityId: z.string(), copyNonce: z.string(), createdAt: z.string(),
  target: planTargetSchema, workflow: workflowSchema,
  steps: z.record(z.string(), stepRecordSchema), references: z.array(remoteReferenceSchema), assets: z.array(remoteReferenceSchema), diagnostics: z.array(z.string()),
  status: z.enum(['planned', 'running', 'rejected', 'unknown', 'waiting_for_verification', 'completed']),
  result: operationResultSchema.optional(), observations: z.array(z.union([z.object({ time: z.string(), result: remoteObservationSchema }), z.object({ time: z.string(), error: z.object({ code: z.string(), message: z.string() }) })])),
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
        record = { schema: 3, id, capabilityId: plan.capabilityId, copyNonce: plan.copyNonce, createdAt: new Date().toISOString(), target, workflow: target.workflow,
          steps: {}, references: [], assets: [], diagnostics: [], status: 'planned', observations: [] };
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
      record.steps[step.id] = { ...previous, phase: 'running', references: [] }; record.status = 'running';
      await this.operations.save(record);
      let value: unknown;
      try { value = await session.executeStep(record.capabilityId, step.handler, step.input, dependencies, { ...context, remember: async (remote, role) => { record.steps[step.id].references.push(remote); await context.remember(remote, role); } }); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let phase: StepRecord['phase'] = handler.effect === 'read' ? 'rejected' : 'unknown';
        if (error instanceof CliError && error.details?.outcome === 'rejected') phase = 'rejected';
        if (error instanceof CliError && error.code === 'VERIFICATION') phase = 'waiting_for_verification';
        record.steps[step.id] = { ...record.steps[step.id], phase, message, failure: { code: error instanceof CliError ? error.code : 'INTERNAL', ...(error instanceof CliError && error.code === 'CONFLICT' ? { details: JSON.parse(JSON.stringify(error.details)) } : {}) } };
        if (phase === 'waiting_for_verification') {
          const details = error instanceof CliError ? error.details : undefined;
          const supplied = details?.verification as { kind: string; strategy: 'inspect' | 'continue'; resource?: z.infer<typeof remoteReferenceSchema> } | undefined;
          record.steps[step.id].verification = { id: randomUUID(), kind: supplied?.kind ?? 'platform_verification', stage: step.id, strategy: supplied?.strategy ?? 'inspect', ...(supplied?.resource ? { resource: { kind: supplied.resource.kind, id: supplied.resource.id, ...(supplied.resource.selector ? { selector: supplied.resource.selector } : {}) } } : {}) };
        } record.status = phase; record.message = message;
        await this.operations.save(record); return;
      }
      record.steps[step.id] = { ...record.steps[step.id], phase: 'succeeded', value: JSON.parse(JSON.stringify(value)) };
      if (step.id === record.workflow.resultStep) {
        record.result = parseInput(capability.outputSchema, value) as z.infer<typeof operationResultSchema>;
        if (record.result.observation) record.observations.push({ time: new Date().toISOString(), result: record.result.observation });
        record.status = 'completed'; delete record.message;
        if (!capability.successStates.includes(record.result.status)) {
          record.status = 'unknown'; record.steps[step.id].phase = 'unknown'; record.message = '当前结果尚未达到此能力的完成条件。';
        }
        if (record.result.status === 'rejected' || record.result.status === 'waiting_for_verification' || record.result.status === 'unknown') {
          record.status = record.result.status; record.steps[step.id].phase = record.result.status; record.message = record.result.message;
        }
      }
      // This record is the authority. Projections and event logs are updated only after it commits.
      await this.operations.save(record);
    }
  }
  async recover(record: OperationRecord, capability: WriteCapability<never>, session: PlatformSession, context: OperationContext): Promise<void> {
    for (const step of record.workflow.steps) {
      const saved = record.steps[step.id];
      if (!saved || !['running', 'unknown', 'waiting_for_verification'].includes(saved.phase)) continue;
      const handler = capability.handlers.get(step.handler)!;
      if (handler.effect === 'read') { saved.phase = 'ready'; await this.operations.save(record); continue; }
      const dependencies = Object.fromEntries(step.needs.map(id => [id, record.steps[id].value]));
      const recovery = await session.recoverStep(record.capabilityId, step.handler, step.input, dependencies, saved, context);
      saved.recovery = { time: new Date().toISOString(), verdict: recovery.verdict, ...recovery.evidence };
      if (recovery.verdict === 'effect_confirmed') {
        let result: OperationResult | undefined;
        let value: unknown;
        if (step.id === record.workflow.resultStep) {
          result = parseInput(capability.outputSchema, recovery.value) as OperationResult;
          value = result;
        } else value = parseInput(handler.outputSchema, recovery.value);
        if (result && !capability.successStates.includes(result.status)) {
          saved.phase = 'unknown'; record.status = 'unknown'; record.message = '回查证据尚未达到此能力的完成条件。';
          saved.recovery.verdict = 'indeterminate'; saved.recovery.message = record.message;
          await this.operations.save(record); continue;
        }
        record.status = 'planned';
        saved.value = value as z.infer<ReturnType<typeof z.json>>;
        saved.phase = 'succeeded'; delete saved.verification; delete saved.message;
        if (result) { record.result = result; record.status = 'completed'; delete record.message; }
      } else if (recovery.verdict === 'not_applied') {
        saved.phase = 'ready'; delete saved.verification; delete saved.value; record.status = 'planned'; delete record.message;
      } else {
        if (saved.phase !== 'waiting_for_verification') saved.phase = 'unknown';
        record.status = saved.phase; record.message = recovery.evidence.message;
      }
      await this.operations.save(record);
    }
  }
}
