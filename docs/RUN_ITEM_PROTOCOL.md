# Streaming Run Item Protocol

The Run Item Protocol is the stable boundary between model/provider adapters, the Harness runtime, persistent stores, and product clients such as Agent Deck. It describes observable work; it does not grant an event authority to advance verified task state.

Current version: `run-item/1`.

## Envelope

Every event carries the same required routing and delivery fields:

```ts
interface RunItemEvent {
  protocolVersion: "run-item/1";
  eventId: string;
  runId: string;
  turnId: string;
  itemId: string;
  sequence: number;
  emittedAt: string;
  idempotencyKey: string;
  kind: RunItemEventKind;
  payload: object;
}
```

`sequence` is a strictly increasing, one-based position scoped to one run. `idempotencyKey` must remain stable when a producer retries the same logical event. `eventId` identifies this serialized event; it is not used as the retry identity.

## Event kinds

| Family | Events | Purpose |
| --- | --- | --- |
| Turn | `turn.started`, `turn.completed` | Bound one Manager, Executor, Auditor, user, or system turn. |
| Text | `text.delta`, `text.completed` | Stream and finalize human-readable output. |
| Tool | `tool.requested`, `tool.completed` | Describe a structured call and its outcome. |
| Approval | `approval.requested`, `approval.resolved` | Pause a risky action and record the decision. |
| Artifact | `artifact.published` | Publish a durable output by URI and optional digest. |
| Audit | `audit.finding` | Report an evidence-backed verification finding. |
| Error | `error.raised` | Report a typed recoverable or terminal error. |
| Run | `run.terminal` | Declare the final externally observable run status. |

## Ordering and delivery

The transport is **at least once** and may deliver events out of order. Consumers follow these rules:

1. Apply events only in contiguous `sequence` order.
2. Buffer future events while a gap exists.
3. Ignore an exact duplicate with the same `idempotencyKey`.
4. Fail closed if one idempotency key describes different content.
5. Fail closed if two different events claim the same sequence.
6. Reject events after `run.terminal`.
7. Request replay from the next expected sequence when a gap persists.

The protocol deliberately does not use wall-clock timestamps for ordering.

## Replay and reconstruction

`RunItemProjector` accepts live or replayed events and builds a serializable projection containing canonical events, turns, items, accumulated text, terminal status, and unresolved sequence gaps.

```ts
const projector = new RunItemProjector(runId);
for (const event of deliveredEvents) projector.ingest(event);

const projection = projector.snapshot();
console.log(projection.lastSequence, projection.pendingSequences);
```

`projectRunItemStream(runId, events)` is the batch equivalent. Replaying the complete event stream from sequence `1` reconstructs the same projection regardless of delivery order or exact duplicate delivery.

## Trust boundary

Run-item events are presentation and transport records. A `text.completed`, `artifact.published`, or `run.terminal` event cannot complete a Harness requirement by itself. Only a clean Auditor result with persisted evidence can advance the verified state ledger.

## Versioning

Breaking envelope or semantic changes require a new protocol version. Producers and consumers must reject unsupported versions rather than interpreting them optimistically. Additive payload fields may be introduced within `run-item/1`; consumers must ignore fields they do not understand.
