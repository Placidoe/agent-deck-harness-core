# Agent Deck Harness Core

This repository owns a small, provider-neutral execution kernel. Keep the core independent from Agent Deck UI code and from any single model or CLI provider.

## Product constraints

- Treat persisted, independently verified state as the source of truth.
- An executor claim never marks a requirement complete.
- Keep each execution context bounded and exclude raw prior trajectories by default.
- Prefer one executor; add decomposition or additional agents only when a measurable policy requires them.
- Human attention is a state transition (`ask`, `approve`, `review`, or `blocked`), not a notification side effect.
- Performance, quality, recovery, and observability are P0. Product-facing ROI is out of scope.

## Engineering constraints

- Preserve provider neutrality in `src/`; adapters belong in separate packages later.
- Add a deterministic test for every state-machine change.
- Persist before emitting externally visible state.
- Avoid runtime dependencies unless they remove more complexity than they add.
- Do not copy code from research repositories without recording its license and provenance.
- Portable model-role adapters may live in the core when they inject the client transport and controlled tools, import no vendor SDK, and keep permissions in the host. Completion requires a fresh read-only audit with host receipts; planning schema validation is explicitly not execution verification.
