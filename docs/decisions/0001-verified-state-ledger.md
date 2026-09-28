# ADR-0001: Use an external verified state ledger

- Status: Accepted
- Date: 2026-09-29

## Context

Long-running agents commonly keep the goal, execution history, progress assessment, and completion claim in one growing conversation. This couples action with self-evaluation, makes recovery dependent on raw context, and allows an incorrect claim to become a premise for later work.

## Decision

The Harness stores requirements, facts, artifacts, blockers, and supporting evidence outside model context. An executor may mutate the environment and return an unverified report. A separate auditor inspects the environment. Only evidence from a clean audit can advance trusted state.

Each executor invocation receives a bounded contract and explicitly referenced state. Raw event history remains available for replay and diagnostics but is not automatically included in execution context.

## Consequences

Positive:

- process restart does not erase task progress;
- completion is grounded in inspectable evidence;
- providers can be replaced without changing product state semantics;
- the product can explain why it is running, blocked, or asking for attention;
- context size is not proportional to total trajectory length.

Costs:

- independent auditing adds latency and model/tool usage;
- state schemas require migrations and compatibility discipline;
- read-only enforcement must be implemented by environment adapters;
- adaptive verification is needed to avoid unnecessary overhead on simple tasks.

## Alternatives rejected

- **Persist the full conversation and resume it.** Easy initially, but preserves noise and self-assessment errors.
- **Trust executor structured output.** Faster, but cannot distinguish a claim from actual environment state.
- **Make the DAG the source of truth.** A graph is useful presentation, but does not provide evidence provenance or safe recovery semantics.

