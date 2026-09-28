import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentHarness,
  JsonFileRunStore,
  MemoryRunStore,
} from "../dist/index.js";

function verifiedAudit(requirementId = "r1") {
  return {
    outcome: "complete",
    integrity: "clean",
    summary: "The environment satisfies the contract.",
    evidence: [
      {
        id: "e1",
        kind: "test",
        summary: "Acceptance test passed.",
        observedAt: "2026-09-29T00:00:00.000Z",
      },
    ],
    requirementUpdates: [
      { id: requirementId, status: "completed", evidenceIds: ["e1"] },
    ],
  };
}

function oneContractManager() {
  let calls = 0;
  return {
    async decide() {
      calls += 1;
      if (calls === 1) {
        return {
          type: "execute",
          contract: {
            id: "c1",
            title: "Create output",
            goal: "Create and verify the requested output.",
            acceptanceCriteria: ["The acceptance test passes."],
            constraints: ["Do not modify unrelated files."],
            contextRefs: ["r1"],
            risk: "low",
          },
        };
      }
      return { type: "done", summary: "Verified delivery." };
    },
  };
}

const executor = {
  async execute() {
    return { summary: "Created the output.", claimedComplete: true };
  },
};

test("only audited evidence can complete a run", async () => {
  const store = new MemoryRunStore();
  const harness = new AgentHarness({ store });
  const state = await harness.start({
    runId: "verified-run",
    goal: "Deliver a tested output.",
    requirements: [{ id: "r1", description: "Output passes its acceptance test." }],
    manager: oneContractManager(),
    executor,
    auditor: { async audit() { return verifiedAudit(); } },
  });

  assert.equal(state.status, "completed");
  assert.equal(state.requirements[0].status, "completed");
  assert.equal(state.metrics.executorCalls, 1);
  assert.equal(state.metrics.auditorCalls, 1);
  assert.ok(state.eventSequence > 0);
});

test("an executor claim without evidence cannot complete a run", async () => {
  const harness = new AgentHarness({ store: new MemoryRunStore() });
  const state = await harness.start({
    runId: "unverified-run",
    goal: "Deliver a tested output.",
    requirements: [{ id: "r1", description: "Output passes its acceptance test." }],
    manager: oneContractManager(),
    executor,
    auditor: {
      async audit() {
        return {
          outcome: "complete",
          integrity: "clean",
          summary: "The executor claimed completion, but no evidence was found.",
          evidence: [],
          requirementUpdates: [
            { id: "r1", status: "completed", evidenceIds: [] },
          ],
        };
      },
    },
  });

  assert.equal(state.status, "blocked");
  assert.equal(state.requirements[0].status, "untrusted");
  assert.equal(state.attention.type, "invalid_completion");
});

test("execution context contains referenced state, not the raw trajectory", async () => {
  const store = new MemoryRunStore();
  let capturedContext;
  const harness = new AgentHarness({ store });

  const state = await harness.start({
    runId: "bounded-context",
    goal: "Use only relevant state.",
    requirements: [
      { id: "r1", description: "Relevant requirement." },
      { id: "r2", description: "Unrelated requirement." },
    ],
    manager: oneContractManager(),
    executor: {
      async execute({ context }) {
        capturedContext = context;
        return { summary: "Done.", claimedComplete: true };
      },
    },
    auditor: { async audit() { return verifiedAudit(); } },
  });

  assert.equal(state.status, "blocked");
  assert.deepEqual(capturedContext.requirements.map((item) => item.id), ["r1"]);
  assert.equal("events" in capturedContext, false);
});

test("a persisted run can resume after asking for attention", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-deck-harness-"));
  const store = new JsonFileRunStore(root);
  const firstHarness = new AgentHarness({ store });
  const waiting = await firstHarness.start({
    runId: "durable-run",
    goal: "Resume safely.",
    requirements: [{ id: "r1", description: "The result is verified." }],
    manager: {
      async decide() {
        return {
          type: "ask",
          question: "Which target should be used?",
          reason: "The target cannot be inferred safely.",
          suggestedResponses: ["staging", "production"],
        };
      },
    },
    executor,
    auditor: { async audit() { return verifiedAudit(); } },
  });
  assert.equal(waiting.status, "needs_input");

  const secondHarness = new AgentHarness({ store });
  const completed = await secondHarness.resume({
    runId: "durable-run",
    note: "Use staging.",
    manager: oneContractManager(),
    executor,
    auditor: { async audit() { return verifiedAudit(); } },
  });

  assert.equal(completed.status, "completed");
  const eventLog = await readFile(
    join(root, "runs", "durable-run", "events.jsonl"),
    "utf8",
  );
  assert.match(eventLog, /run\.resumed/);
  assert.match(eventLog, /run\.completed/);
  const sequences = eventLog
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).sequence);
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1));
});
