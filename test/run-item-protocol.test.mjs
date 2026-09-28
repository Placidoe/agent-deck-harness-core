import assert from "node:assert/strict";
import test from "node:test";

import {
  createRunItemEvent,
  projectRunItemStream,
  RunItemProjector,
} from "../dist/index.js";

function event(sequence, kind, payload, overrides = {}) {
  return createRunItemEvent({
    eventId: `event-${sequence}`,
    runId: "run-1",
    turnId: "turn-1",
    itemId: overrides.itemId ?? `item-${sequence}`,
    sequence,
    emittedAt: `2026-09-29T00:00:0${sequence}.000Z`,
    idempotencyKey: overrides.idempotencyKey ?? `key-${sequence}`,
    kind,
    payload,
  });
}

const stream = [
  event(1, "turn.started", { role: "executor", label: "Implement feature" }, { itemId: "turn-1" }),
  event(2, "text.delta", { delta: "hello " }, { itemId: "message-1" }),
  event(3, "text.delta", { delta: "world" }, { itemId: "message-1" }),
  event(4, "text.completed", {}, { itemId: "message-1" }),
  event(5, "artifact.published", {
    artifactId: "artifact-1",
    uri: "file:///report.html",
    title: "Report",
    mediaType: "text/html",
  }, { itemId: "artifact-1" }),
  event(6, "turn.completed", { outcome: "completed", summary: "Delivered." }, { itemId: "turn-1" }),
  event(7, "run.terminal", { status: "completed", summary: "Verified." }, { itemId: "terminal-1" }),
];

test("reconstructs a canonical run from out-of-order delivery", () => {
  const projection = projectRunItemStream("run-1", [
    stream[1],
    stream[0],
    stream[4],
    stream[3],
    stream[2],
    stream[6],
    stream[5],
  ]);

  assert.equal(projection.lastSequence, 7);
  assert.deepEqual(projection.pendingSequences, []);
  assert.deepEqual(projection.events.map(({ sequence }) => sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(projection.items.find(({ itemId }) => itemId === "message-1").text, "hello world");
  assert.equal(projection.turns[0].status, "completed");
  assert.equal(projection.terminal.status, "completed");
});

test("buffers gaps and drains them when the missing event arrives", () => {
  const projector = new RunItemProjector("run-1");
  const buffered = projector.ingest(stream[1]);
  assert.equal(buffered.disposition, "buffered");
  assert.deepEqual(projector.snapshot().pendingSequences, [2]);

  const applied = projector.ingest(stream[0]);
  assert.equal(applied.disposition, "applied");
  assert.deepEqual(applied.applied.map(({ sequence }) => sequence), [1, 2]);
  assert.equal(applied.nextExpectedSequence, 3);
});

test("ignores exact at-least-once duplicates", () => {
  const projector = new RunItemProjector("run-1");
  projector.ingest(stream[0]);
  const duplicate = projector.ingest(stream[0]);
  assert.equal(duplicate.disposition, "duplicate");
  assert.equal(projector.snapshot().events.length, 1);
});

test("fails closed on idempotency and sequence collisions", () => {
  const projector = new RunItemProjector("run-1");
  projector.ingest(stream[0]);

  const reusedKey = event(2, "text.delta", { delta: "different" }, {
    itemId: "message-1",
    idempotencyKey: "key-1",
  });
  assert.throws(() => projector.ingest(reusedKey), /Idempotency key collision/);

  const reusedSequence = event(1, "text.delta", { delta: "different" }, {
    itemId: "message-1",
    idempotencyKey: "another-key",
  });
  assert.throws(() => projector.ingest(reusedSequence), /Sequence collision/);
});

test("rejects incomplete and unsupported envelopes", () => {
  const projector = new RunItemProjector("run-1");
  assert.throws(
    () => projector.ingest({ protocolVersion: "run-item/1" }),
    /non-empty eventId/,
  );
  assert.throws(
    () => projector.ingest({ ...stream[0], protocolVersion: "run-item/2" }),
    /Unsupported run item protocol/,
  );
  assert.throws(
    () => projector.ingest({
      ...stream[0],
      kind: "tool.requested",
      payload: { toolName: "shell" },
    }),
    /payload.callId/,
  );
});

test("does not apply events after a terminal state", () => {
  const projector = new RunItemProjector("run-1");
  for (const item of stream) projector.ingest(item);
  assert.throws(
    () => projector.ingest(event(8, "error.raised", {
      code: "TOO_LATE",
      message: "This event followed terminal state.",
      recoverable: false,
    })),
    /terminal run cannot accept additional events/,
  );
});
