export { CliError } from './shared/errors.js';
export { PlatformRegistry } from './core/registry.js';
export { definePlatform } from './core/platform.js';
export type { Platform, PlatformSession } from './core/platform.js';
export { readCapability, writeCapability, workflowCapability } from './core/capability.js';
export type { Capability, ReadCapability, WriteCapability } from './core/capability.js';
export type { AccountIdentity, AccountBinding, AccountScope, AccountProfile, CapabilityContext, CapabilityAvailability, OperationContext, OperationResult, RemoteReference, RemoteObservation } from './core/types.js';
export { PublishingService } from './services/publishing.js';
export type { PublishJob, TargetJob, StepRecord } from './services/publishing.js';
export { AccountRepository } from './runtime/accounts.js';
export { createWmProgram, runWmCli } from './cli/wm-program.js';
export { defaultRegistry } from './platform/builtins.js';

export { PlanningService } from './services/planning.js';
export type { PublishPlan, PlanTarget } from './services/planning.js';
export type { Artifact, ArtifactReader, ArtifactStore, ContentPreparation, ContentRevision, PreparedVariant } from './core/content.js';
export { PreparationContext } from './content/preparation.js';
export { ObjectStore } from './runtime/objects.js';

export { stepHandler } from './core/workflow.js';
export type { CompiledWorkflow, StepHandler, StepRecovery, RecoveryState, RecoveryEvidence, Verification } from './core/workflow.js';
export { OperationRepository } from './services/operations.js';
export type { OperationRecord } from './services/operations.js';
export { PublicationService } from './services/publications.js';
export type { Publication } from './services/publications.js';
