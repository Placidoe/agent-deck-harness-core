# Roadmap

The roadmap is ordered by research risk, not feature breadth. Each milestone must improve a fixed evaluation suite before the next one begins.

## M0 — Verified execution kernel (current)

- [x] Provider-neutral Manager / Executor / Auditor contracts
- [x] Persistent verified state ledger
- [x] Bounded execution contexts
- [x] Independent audit gate
- [x] Human-attention states
- [x] Durable JSON event log and restart resume
- [x] Basic latency and call-count metrics
- [x] Deterministic state-machine tests

Exit criterion: executor self-reports cannot produce false completion, and a stopped process can resume from persisted state.

## M1 — Production event and tool protocol

- [ ] Streaming run-item protocol with stable event schemas
- [ ] Idempotency keys and optimistic concurrency control
- [ ] Cancellation, deadline, heartbeat, and stale-run recovery
- [ ] Structured tool registry with read/write/risk metadata
- [ ] Approval policy and immutable audit trail
- [ ] Process sandbox adapter
- [ ] SQLite store and schema migrations

Exit criterion: forced process termination, duplicated delivery, or a stale writer cannot corrupt a run.

## M2 — Context kernel

- [ ] Task-anchor / verified-memory / working-set separation
- [ ] Phase-boundary context folding
- [ ] Evidence and artifact retrieval by reference
- [ ] Tool-output size controls and spill storage
- [ ] Context-budget accounting
- [ ] Memory accuracy, update, and selective-forgetting tests

Exit criterion: long runs remain within a fixed context budget without losing acceptance-critical facts.

## M3 — Adaptive execution

- [ ] Direct, verified-direct, and managed execution modes
- [ ] Complexity and risk router
- [ ] Verification gates based on side effects and uncertainty
- [ ] Targeted repair rather than full reruns
- [ ] Sparse worker handoffs through verified state
- [ ] Bounded parallel execution for genuinely independent work

Exit criterion: managed execution improves success without regressing median latency on simple tasks.

## M4 — Provider adapters and SDK release

- [ ] OpenAI-compatible API adapter
- [ ] Codex adapter
- [ ] Claude Code adapter
- [ ] DeepSeek Harness compatibility adapter
- [ ] Adapter conformance suite
- [ ] Stable package exports and semantic-version policy
- [ ] Agent Deck integration package

Exit criterion: the same fixture suite produces equivalent state transitions across at least two providers.

## Evaluation gates

Every milestone reports:

- verified task success;
- repeated-run `pass^k`;
- time to first useful action;
- wall-clock completion time;
- peak context size;
- repeated or no-progress tool calls;
- human interventions;
- recovery rate after injected failure.

