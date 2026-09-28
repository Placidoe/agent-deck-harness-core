import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AgentHarness,
  SqliteRunStore,
} from "../dist/index.js";

function adapters() {
  let managerCalls = 0;
  return {
    manager: {
      async decide() {
        managerCalls += 1;
        if (managerCalls === 1) {
          return {
            type: "execute",
            contract: {
              id: "contract-1",
              title: "Deliver",
              goal: "Deliver the result.",
              acceptanceCriteria: ["Test passes."],
              constraints: [],
              contextRefs: ["requirement-1"],
              risk: "low",
            },
          };
        }
        return { type: "done", summary: "Verified." };
      },
    },
    executor: {
      async execute() {
        return { summary: "Implemented.", claimedComplete: true };
      },
    },
    auditor: {
      async audit() {
        return {
          outcome: "complete",
          integrity: "clean",
          summary: "Verified from the environment.",
          evidence: [{
            id: "evidence-1",
            kind: "test",
            summary: "Test passed.",
            observedAt: "2026-09-29T00:00:00.000Z",
          }],
          requirementUpdates: [{
            id: "requirement-1",
            status: "completed",
            evidenceIds: ["evidence-1"],
          }],
        };
      },
    },
  };
}

async function databasePath() {
  const root = await mkdtemp(join(tmpdir(), "agent-deck-sqlite-"));
  return join(root, "runs.sqlite");
}

test("persists an event and its snapshot in one SQLite transaction", async () => {
  const filename = await databasePath();
  const store = new SqliteRunStore(filename);
  const state = await new AgentHarness({ store }).start({
    runId: "sqlite-run",
    goal: "Prove transactional persistence.",
    requirements: [{ id: "requirement-1", description: "Test passes." }],
    ...adapters(),
  });

  assert.equal(state.status, "completed");
  assert.equal(store.integrityCheck(), "ok");
  const events = await store.readEvents("sqlite-run");
  assert.equal(events.at(-1).sequence, state.eventSequence);
  store.close();

  const reopened = new SqliteRunStore(filename);
  assert.deepEqual(await reopened.load("sqlite-run"), state);
  reopened.close();
});

test("rolls back the snapshot when its event insert fails", async () => {
  const store = new SqliteRunStore(":memory:");
  await new AgentHarness({ store }).start({
    runId: "atomic-run",
    goal: "Keep state and event atomic.",
    requirements: [{ id: "requirement-1", description: "Test passes." }],
    ...adapters(),
  });

  const before = await store.load("atomic-run");
  const events = await store.readEvents("atomic-run");
  const lastEvent = events.at(-1);
  const rejectedState = structuredClone(before);
  rejectedState.goal = "This update must roll back.";
  rejectedState.eventSequence += 1;
  rejectedState.updatedAt = "2026-09-29T01:00:00.000Z";
  const duplicateIdEvent = {
    ...lastEvent,
    sequence: rejectedState.eventSequence,
    occurredAt: rejectedState.updatedAt,
    data: { injectedFailure: true },
  };

  await assert.rejects(
    store.commit(rejectedState, duplicateIdEvent),
    /UNIQUE constraint failed: events.event_id/,
  );
  assert.deepEqual(await store.load("atomic-run"), before);
  assert.equal((await store.readEvents("atomic-run")).length, events.length);
  store.close();
});

test("pages event history with a sequence cursor", async () => {
  const store = new SqliteRunStore(":memory:");
  await new AgentHarness({ store }).start({
    runId: "paged-run",
    goal: "Page events.",
    requirements: [{ id: "requirement-1", description: "Test passes." }],
    ...adapters(),
  });

  const first = await store.readEventPage("paged-run", { limit: 2 });
  assert.equal(first.events.length, 2);
  assert.equal(first.nextCursor, 2);
  const second = await store.readEventPage("paged-run", {
    afterSequence: first.nextCursor,
    limit: 500,
  });
  assert.ok(second.events.length > 0);
  assert.equal(second.events[0].sequence, 3);
  assert.equal(second.nextCursor, undefined);
  store.close();
});

test("lists run metadata without exposing serialized histories", async () => {
  const store = new SqliteRunStore(":memory:");
  await new AgentHarness({ store }).start({
    runId: "listed-run",
    goal: "List runs cheaply.",
    requirements: [{ id: "requirement-1", description: "Test passes." }],
    ...adapters(),
  });

  const [summary] = await store.listRuns();
  assert.equal(summary.runId, "listed-run");
  assert.equal(summary.status, "completed");
  assert.equal("snapshot" in summary, false);
  assert.equal("events" in summary, false);
  store.close();
});

test("recovers a corrupt current snapshot from the latest transaction checkpoint", async () => {
  const filename = await databasePath();
  const store = new SqliteRunStore(filename);
  const state = await new AgentHarness({ store }).start({
    runId: "recoverable-run",
    goal: "Recover the snapshot.",
    requirements: [{ id: "requirement-1", description: "Test passes." }],
    ...adapters(),
  });
  store.close();

  const raw = new DatabaseSync(filename);
  raw.prepare("UPDATE runs SET snapshot_json = ? WHERE run_id = ?")
    .run("{broken", "recoverable-run");
  raw.close();

  const recoveredStore = new SqliteRunStore(filename);
  assert.deepEqual(await recoveredStore.load("recoverable-run"), state);
  assert.equal(recoveredStore.integrityCheck(), "ok");
  recoveredStore.close();
});

test("applies and reverses registered migrations", () => {
  const store = new SqliteRunStore(":memory:");
  assert.equal(store.rollbackLastMigration(), 1);
  store.migrate();
  assert.equal(store.integrityCheck(), "ok");
  store.close();
});
