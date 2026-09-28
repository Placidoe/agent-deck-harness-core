import type { ExecutionContext, RunState, SubtaskContract } from "./types.js";

export function buildExecutionContext(
  state: Readonly<RunState>,
  contract: SubtaskContract,
): ExecutionContext {
  const references = new Set(contract.contextRefs);
  const evidenceIds = new Set<string>();

  const requirements = state.requirements
    .filter((record) => references.has(record.id))
    .map((record) => structuredClone(record));
  const facts = state.facts
    .filter((record) => references.has(record.id))
    .map((record) => structuredClone(record));
  const artifacts = state.artifacts
    .filter((record) => references.has(record.id))
    .map((record) => structuredClone(record));

  for (const record of [...requirements, ...facts, ...artifacts]) {
    for (const evidenceId of record.evidenceIds) evidenceIds.add(evidenceId);
  }

  return {
    runId: state.runId,
    round: state.round,
    originalGoal: state.goal,
    contract: structuredClone(contract),
    requirements,
    facts,
    artifacts,
    evidence: state.evidence
      .filter((record) => references.has(record.id) || evidenceIds.has(record.id))
      .map((record) => structuredClone(record)),
  };
}

