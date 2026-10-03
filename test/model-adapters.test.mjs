import test from "node:test";
import assert from "node:assert/strict";
import { AgentHarness, MemoryRunStore, createModelAdapters } from "../dist/portable.js";

const assistant = (content, tool_calls) => ({ role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) });
const read = { definition: { type: "function", function: { name: "read", description: "Read evidence", parameters: { type: "object" } } }, readOnly: true, execute: async () => ({ text: "Observed test passes", ok: true }) };
const write = { definition: { type: "function", function: { name: "write", description: "Controlled write", parameters: { type: "object" } } }, readOnly: false, execute: async () => { throw new Error("Should not be called by auditor"); } };
const call = (name) => [{ id: "tool-call", type: "function", function: { name, arguments: "{}" } }];
async function run(options) {
  return new AgentHarness({ store: new MemoryRunStore() }).start({ ...createModelAdapters(options), goal: "Inspect the workspace", requirements: [{ id: "r1", description: "Observed evidence" }], maxRounds: 2 });
}

test("single executor and fresh read-only auditor complete only with host tool receipts", async () => {
  let n = 0;
  const result = await run({ tools: [read, write], client: { async complete(input) {
    n++;
    if (n === 1) return assistant("Executor claim");
    assert.deepEqual(input.tools.map((tool) => tool.function.name), ["read"]);
    assert.equal(input.messages.some((message) => message.role === "assistant" && message.content === "Executor claim"), false);
    if (n === 2) return assistant(null, call("read"));
    return assistant('{"passed":true,"summary":"Independently observed"}');
  } } });
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.executorCalls, 1);
  assert.equal(result.metrics.auditorCalls, 1);
  assert.match(result.evidence[0].id, /^receipt-/);
});

test("auditor cannot fabricate evidence by claiming passed without a tool observation", async () => {
  const result = await run({ tools: [read], client: { complete: async () => assistant('{"passed":true,"summary":"Trust me"}') } });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.requirements[0].status, "pending");
});

test("planning schema validation does not pretend to verify workspace execution", async () => {
  const options = { tools: [read], planningOnly: true, verifyOutput: (text) => JSON.parse(text).title ? [] : ["Missing title"], client: { complete: async () => assistant('{"title":"A plan"}') } };
  const state = await run(options);
  assert.equal(state.status, "completed");
  assert.match(state.lastAudit.summary, /does not verify workspace execution/);
  assert.throws(() => createModelAdapters({ ...options, tools: [write] }), /read-only tools/);
});

test("bounded contexts stop explicitly and do not silently discard the contract", async () => {
  let calls = 0;
  const adapters = createModelAdapters({ tools: [], maxContextChars: 4000, client: { complete: async () => { calls++; return assistant("claim"); } } });
  await assert.rejects(new AgentHarness({ store: new MemoryRunStore() }).start({ ...adapters, goal: "x".repeat(5000), requirements: [{ id: "r", description: "bounded" }] }), /context budget exhausted/);
  assert.equal(calls, 0);
});

test("a verified last-budget round can complete without granting another execution", async () => {
  const adapters = createModelAdapters({ tools: [], planningOnly: true, verifyOutput: () => [], client: { complete: async () => assistant("Plan") } });
  const state = await new AgentHarness({ store: new MemoryRunStore() }).start({ ...adapters, goal: "Plan", requirements: [{ id: "r", description: "Valid plan" }], maxRounds: 1 });
  assert.equal(state.status, "completed");
  assert.equal(state.metrics.executorCalls, 1);
});
