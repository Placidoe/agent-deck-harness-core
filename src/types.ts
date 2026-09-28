export type RunStatus =
  | "running"
  | "needs_input"
  | "blocked"
  | "completed"
  | "budget_exhausted"
  | "canceled";

export type RecordStatus = "pending" | "completed" | "blocked" | "untrusted";

export interface EvidenceRecord {
  id: string;
  kind: "command" | "file" | "test" | "observation" | "user" | "other";
  summary: string;
  locator?: string;
  observedAt: string;
}

export interface RequirementRecord {
  id: string;
  description: string;
  status: RecordStatus;
  evidenceIds: string[];
}

export interface FactRecord {
  id: string;
  key: string;
  value: unknown;
  status: Exclude<RecordStatus, "pending">;
  evidenceIds: string[];
}

export interface ArtifactRecord {
  id: string;
  uri: string;
  description: string;
  mediaType?: string;
  status: Exclude<RecordStatus, "pending">;
  evidenceIds: string[];
}

export interface BlockerRecord {
  id: string;
  summary: string;
  detail?: string;
  recoverable: boolean;
  suggestedAction?: string;
}

export interface SubtaskContract {
  id: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  constraints: string[];
  contextRefs: string[];
  risk: "low" | "medium" | "high";
}

export interface ExecutionContext {
  runId: string;
  round: number;
  originalGoal: string;
  contract: SubtaskContract;
  requirements: RequirementRecord[];
  facts: FactRecord[];
  artifacts: ArtifactRecord[];
  evidence: EvidenceRecord[];
}

export interface ExecutionReport {
  summary: string;
  claimedComplete: boolean;
  observations?: string[];
  producedArtifacts?: Array<{
    id: string;
    uri: string;
    description: string;
    mediaType?: string;
  }>;
}

export interface AuditReport {
  outcome: "complete" | "incomplete" | "blocked";
  integrity: "clean" | "suspect" | "violation";
  summary: string;
  evidence: EvidenceRecord[];
  requirementUpdates?: Array<{
    id: string;
    status: RecordStatus;
    evidenceIds: string[];
  }>;
  facts?: FactRecord[];
  artifacts?: ArtifactRecord[];
  blockers?: BlockerRecord[];
}

export type ManagerDecision =
  | { type: "execute"; contract: SubtaskContract }
  | { type: "done"; summary: string }
  | {
      type: "ask";
      question: string;
      reason: string;
      suggestedResponses?: string[];
    }
  | { type: "blocked"; blocker: BlockerRecord };

export interface AttentionRequest {
  type: "ask" | "blocked" | "budget_exhausted" | "invalid_completion";
  title: string;
  detail: string;
  suggestedAction?: string;
  suggestedResponses?: string[];
}

export interface RunMetrics {
  managerCalls: number;
  executorCalls: number;
  auditorCalls: number;
  managerMs: number;
  executorMs: number;
  auditorMs: number;
}

export interface RunState {
  schemaVersion: 1;
  runId: string;
  goal: string;
  status: RunStatus;
  round: number;
  eventSequence: number;
  createdAt: string;
  updatedAt: string;
  requirements: RequirementRecord[];
  facts: FactRecord[];
  artifacts: ArtifactRecord[];
  evidence: EvidenceRecord[];
  blockers: BlockerRecord[];
  activeContract?: SubtaskContract;
  lastExecution?: ExecutionReport;
  lastAudit?: AuditReport;
  attention?: AttentionRequest;
  completionSummary?: string;
  metrics: RunMetrics;
}

export interface HarnessEvent {
  id: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  type:
    | "run.created"
    | "run.resumed"
    | "manager.decided"
    | "executor.started"
    | "executor.finished"
    | "auditor.started"
    | "auditor.finished"
    | "state.updated"
    | "attention.required"
    | "run.completed"
    | "run.canceled";
  data: Record<string, unknown>;
}

export interface Manager {
  decide(input: { state: Readonly<RunState> }): Promise<ManagerDecision>;
}

export interface Executor {
  execute(input: {
    context: Readonly<ExecutionContext>;
    signal?: AbortSignal;
  }): Promise<ExecutionReport>;
}

export interface Auditor {
  audit(input: {
    state: Readonly<RunState>;
    context: Readonly<ExecutionContext>;
    execution: Readonly<ExecutionReport>;
    signal?: AbortSignal;
  }): Promise<AuditReport>;
}

export interface RunStore {
  load(runId: string): Promise<RunState | undefined>;
  save(state: RunState): Promise<void>;
  append(event: HarnessEvent): Promise<void>;
  readEvents(runId: string): Promise<HarnessEvent[]>;
}

export interface HarnessAdapters {
  manager: Manager;
  executor: Executor;
  auditor: Auditor;
}

export interface StartRunInput extends HarnessAdapters {
  runId?: string;
  goal: string;
  requirements: Array<{ id: string; description: string }>;
  maxRounds?: number;
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
}

export interface ResumeRunInput extends HarnessAdapters {
  runId: string;
  note?: string;
  maxRounds?: number;
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
}
