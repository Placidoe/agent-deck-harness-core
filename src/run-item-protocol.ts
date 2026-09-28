import { isDeepStrictEqual } from "node:util";

import type { RunStatus } from "./types.js";

export const RUN_ITEM_PROTOCOL_VERSION = "run-item/1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface RunItemPayloads {
  "turn.started": {
    role: "manager" | "executor" | "auditor" | "user" | "system";
    label?: string;
  };
  "turn.completed": {
    outcome: "completed" | "failed" | "canceled";
    summary?: string;
  };
  "text.delta": {
    delta: string;
  };
  "text.completed": {
    text?: string;
  };
  "tool.requested": {
    callId: string;
    toolName: string;
    arguments: JsonValue;
    access: "read" | "write";
    risk: "low" | "medium" | "high";
  };
  "tool.completed": {
    callId: string;
    outcome: "completed" | "failed" | "canceled";
    result?: JsonValue;
    error?: string;
  };
  "approval.requested": {
    approvalId: string;
    title: string;
    detail: string;
    risk: "low" | "medium" | "high";
  };
  "approval.resolved": {
    approvalId: string;
    decision: "approved" | "denied" | "canceled";
    note?: string;
  };
  "artifact.published": {
    artifactId: string;
    uri: string;
    title: string;
    mediaType?: string;
    digest?: string;
  };
  "audit.finding": {
    findingId: string;
    level: "info" | "warning" | "error";
    summary: string;
    evidenceRefs: string[];
  };
  "error.raised": {
    code: string;
    message: string;
    recoverable: boolean;
    detail?: JsonValue;
  };
  "run.terminal": {
    status: Exclude<RunStatus, "running">;
    summary?: string;
  };
}

export type RunItemEventKind = keyof RunItemPayloads;

interface RunItemEnvelope<K extends RunItemEventKind> {
  protocolVersion: typeof RUN_ITEM_PROTOCOL_VERSION;
  eventId: string;
  runId: string;
  turnId: string;
  itemId: string;
  sequence: number;
  emittedAt: string;
  idempotencyKey: string;
  kind: K;
  payload: RunItemPayloads[K];
}

export type RunItemEvent<K extends RunItemEventKind = RunItemEventKind> = {
  [P in K]: RunItemEnvelope<P>;
}[K];

export type RunItemStatus =
  | "streaming"
  | "requested"
  | "waiting"
  | "completed"
  | "failed"
  | "canceled";

export interface ProjectedRunItem {
  itemId: string;
  turnId: string;
  status: RunItemStatus;
  kinds: RunItemEventKind[];
  createdAt: string;
  updatedAt: string;
  text?: string;
  latest: RunItemEvent;
}

export interface ProjectedTurn {
  turnId: string;
  status: "running" | "completed" | "failed" | "canceled";
  startedAt: string;
  completedAt?: string;
  itemIds: string[];
}

export interface RunItemProjection {
  protocolVersion: typeof RUN_ITEM_PROTOCOL_VERSION;
  runId: string;
  lastSequence: number;
  events: RunItemEvent[];
  turns: ProjectedTurn[];
  items: ProjectedRunItem[];
  terminal?: RunItemPayloads["run.terminal"];
  pendingSequences: number[];
}

export interface IngestResult {
  disposition: "applied" | "buffered" | "duplicate";
  applied: RunItemEvent[];
  nextExpectedSequence: number;
}

const EVENT_KINDS = new Set<RunItemEventKind>([
  "turn.started",
  "turn.completed",
  "text.delta",
  "text.completed",
  "tool.requested",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
  "artifact.published",
  "audit.finding",
  "error.raised",
  "run.terminal",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  payload: Record<string, unknown>,
  field: string,
  kind: RunItemEventKind,
): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${kind} requires a non-empty payload.${field}.`);
  }
  return value;
}

function optionalString(
  payload: Record<string, unknown>,
  field: string,
  kind: RunItemEventKind,
): void {
  const value = payload[field];
  if (value !== undefined && typeof value !== "string") {
    throw new TypeError(`${kind} payload.${field} must be a string when provided.`);
  }
}

function requireBoolean(
  payload: Record<string, unknown>,
  field: string,
  kind: RunItemEventKind,
): void {
  if (typeof payload[field] !== "boolean") {
    throw new TypeError(`${kind} requires a boolean payload.${field}.`);
  }
}

function requireEnum(
  payload: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
  kind: RunItemEventKind,
): void {
  if (typeof payload[field] !== "string" || !allowed.includes(payload[field])) {
    throw new TypeError(
      `${kind} payload.${field} must be one of: ${allowed.join(", ")}.`,
    );
  }
}

function assertJsonValue(value: unknown, path: string, seen = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`${path} must not contain a cycle.`);
    seen.add(value);
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  if (isRecord(value)) {
    if (seen.has(value)) throw new TypeError(`${path} must not contain a cycle.`);
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }
  throw new TypeError(`${path} must be JSON-safe.`);
}

function assertPayload(kind: RunItemEventKind, payload: Record<string, unknown>): void {
  assertJsonValue(payload, `${kind} payload`);
  switch (kind) {
    case "turn.started":
      requireEnum(payload, "role", ["manager", "executor", "auditor", "user", "system"], kind);
      optionalString(payload, "label", kind);
      return;
    case "turn.completed":
      requireEnum(payload, "outcome", ["completed", "failed", "canceled"], kind);
      optionalString(payload, "summary", kind);
      return;
    case "text.delta":
      if (typeof payload.delta !== "string") {
        throw new TypeError("text.delta requires a string payload.delta.");
      }
      return;
    case "text.completed":
      optionalString(payload, "text", kind);
      return;
    case "tool.requested":
      requireString(payload, "callId", kind);
      requireString(payload, "toolName", kind);
      if (!("arguments" in payload)) throw new TypeError("tool.requested requires payload.arguments.");
      assertJsonValue(payload.arguments, "tool.requested payload.arguments");
      requireEnum(payload, "access", ["read", "write"], kind);
      requireEnum(payload, "risk", ["low", "medium", "high"], kind);
      return;
    case "tool.completed":
      requireString(payload, "callId", kind);
      requireEnum(payload, "outcome", ["completed", "failed", "canceled"], kind);
      if (payload.result !== undefined) assertJsonValue(payload.result, "tool.completed payload.result");
      optionalString(payload, "error", kind);
      return;
    case "approval.requested":
      requireString(payload, "approvalId", kind);
      requireString(payload, "title", kind);
      requireString(payload, "detail", kind);
      requireEnum(payload, "risk", ["low", "medium", "high"], kind);
      return;
    case "approval.resolved":
      requireString(payload, "approvalId", kind);
      requireEnum(payload, "decision", ["approved", "denied", "canceled"], kind);
      optionalString(payload, "note", kind);
      return;
    case "artifact.published":
      requireString(payload, "artifactId", kind);
      requireString(payload, "uri", kind);
      requireString(payload, "title", kind);
      optionalString(payload, "mediaType", kind);
      optionalString(payload, "digest", kind);
      return;
    case "audit.finding":
      requireString(payload, "findingId", kind);
      requireEnum(payload, "level", ["info", "warning", "error"], kind);
      requireString(payload, "summary", kind);
      if (
        !Array.isArray(payload.evidenceRefs) ||
        !payload.evidenceRefs.every((reference) => typeof reference === "string")
      ) {
        throw new TypeError("audit.finding requires a string[] payload.evidenceRefs.");
      }
      return;
    case "error.raised":
      requireString(payload, "code", kind);
      requireString(payload, "message", kind);
      requireBoolean(payload, "recoverable", kind);
      if (payload.detail !== undefined) assertJsonValue(payload.detail, "error.raised payload.detail");
      return;
    case "run.terminal":
      requireEnum(
        payload,
        "status",
        ["needs_input", "blocked", "completed", "budget_exhausted", "canceled"],
        kind,
      );
      optionalString(payload, "summary", kind);
      return;
  }
}

export function assertRunItemEvent(value: unknown): asserts value is RunItemEvent {
  if (!isRecord(value)) throw new TypeError("Run item event must be an object.");
  if (value.protocolVersion !== RUN_ITEM_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported run item protocol: ${String(value.protocolVersion)}`);
  }

  for (const field of ["eventId", "runId", "turnId", "itemId", "emittedAt", "idempotencyKey"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new TypeError(`Run item event requires a non-empty ${field}.`);
    }
  }

  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) {
    throw new TypeError("Run item event sequence must be a positive safe integer.");
  }
  if (Number.isNaN(Date.parse(value.emittedAt as string))) {
    throw new TypeError("Run item event emittedAt must be an ISO-compatible timestamp.");
  }
  if (typeof value.kind !== "string" || !EVENT_KINDS.has(value.kind as RunItemEventKind)) {
    throw new TypeError(`Unknown run item event kind: ${String(value.kind)}`);
  }
  if (!isRecord(value.payload)) {
    throw new TypeError("Run item event payload must be an object.");
  }
  assertPayload(value.kind as RunItemEventKind, value.payload);
}

export function createRunItemEvent<K extends RunItemEventKind>(
  event: Omit<RunItemEnvelope<K>, "protocolVersion">,
): RunItemEvent<K> {
  const value = {
    protocolVersion: RUN_ITEM_PROTOCOL_VERSION,
    ...event,
  } as RunItemEvent<K>;
  assertRunItemEvent(value);
  return clone(value);
}

/**
 * Applies an at-least-once, possibly out-of-order stream in canonical run order.
 * Gaps are buffered; duplicates are ignored by idempotency key; collisions fail closed.
 */
export class RunItemProjector {
  readonly #runId: string;
  readonly #events: RunItemEvent[] = [];
  readonly #buffer = new Map<number, RunItemEvent>();
  readonly #eventsByIdempotencyKey = new Map<string, RunItemEvent>();
  readonly #turns = new Map<string, ProjectedTurn>();
  readonly #items = new Map<string, ProjectedRunItem>();
  #lastSequence = 0;
  #terminal?: RunItemPayloads["run.terminal"];

  constructor(runId: string) {
    if (!runId) throw new Error("A projector run id is required.");
    this.#runId = runId;
  }

  ingest(value: unknown): IngestResult {
    assertRunItemEvent(value);
    const event = clone(value);
    if (event.runId !== this.#runId) {
      throw new Error(`Event belongs to run ${event.runId}, expected ${this.#runId}.`);
    }

    const existingByKey = this.#eventsByIdempotencyKey.get(event.idempotencyKey);
    if (existingByKey) {
      if (!isDeepStrictEqual(existingByKey, event)) {
        throw new Error(`Idempotency key collision: ${event.idempotencyKey}`);
      }
      return {
        disposition: "duplicate",
        applied: [],
        nextExpectedSequence: this.#lastSequence + 1,
      };
    }

    if (this.#terminal) {
      throw new Error("A terminal run cannot accept additional events.");
    }

    const existingAtSequence =
      this.#buffer.get(event.sequence) ?? this.#events[event.sequence - 1];
    if (existingAtSequence) {
      throw new Error(`Sequence collision at ${event.sequence}.`);
    }
    if (event.sequence <= this.#lastSequence) {
      throw new Error(`Late event cannot replace sequence ${event.sequence}.`);
    }

    this.#eventsByIdempotencyKey.set(event.idempotencyKey, event);
    this.#buffer.set(event.sequence, event);
    const applied = this.#drain();
    return {
      disposition: applied.length > 0 ? "applied" : "buffered",
      applied: clone(applied),
      nextExpectedSequence: this.#lastSequence + 1,
    };
  }

  snapshot(): RunItemProjection {
    return clone({
      protocolVersion: RUN_ITEM_PROTOCOL_VERSION,
      runId: this.#runId,
      lastSequence: this.#lastSequence,
      events: this.#events,
      turns: [...this.#turns.values()],
      items: [...this.#items.values()],
      ...(this.#terminal ? { terminal: this.#terminal } : {}),
      pendingSequences: [...this.#buffer.keys()].sort((a, b) => a - b),
    });
  }

  #drain(): RunItemEvent[] {
    const applied: RunItemEvent[] = [];
    for (;;) {
      const sequence = this.#lastSequence + 1;
      const event = this.#buffer.get(sequence);
      if (!event) return applied;
      if (this.#terminal) {
        throw new Error("A terminal run cannot accept additional events.");
      }
      if (
        event.kind === "run.terminal" &&
        [...this.#buffer.keys()].some((bufferedSequence) => bufferedSequence > sequence)
      ) {
        throw new Error("A terminal event cannot precede buffered run events.");
      }
      this.#buffer.delete(sequence);
      this.#apply(event);
      this.#events.push(event);
      this.#lastSequence = sequence;
      applied.push(event);
    }
  }

  #apply(event: RunItemEvent): void {
    const turn = this.#turns.get(event.turnId);
    if (event.kind === "turn.started") {
      if (turn) throw new Error(`Turn already started: ${event.turnId}`);
      this.#turns.set(event.turnId, {
        turnId: event.turnId,
        status: "running",
        startedAt: event.emittedAt,
        itemIds: [event.itemId],
      });
    } else if (event.kind === "turn.completed") {
      if (!turn) throw new Error(`Turn was not started: ${event.turnId}`);
      turn.status = event.payload.outcome;
      turn.completedAt = event.emittedAt;
    } else if (!turn) {
      throw new Error(`Event references an unknown turn: ${event.turnId}`);
    }

    if (turn && !turn.itemIds.includes(event.itemId)) turn.itemIds.push(event.itemId);

    const current = this.#items.get(event.itemId);
    const kinds = current ? [...current.kinds, event.kind] : [event.kind];
    const text = this.#projectText(current?.text, event);
    const item: ProjectedRunItem = {
      itemId: event.itemId,
      turnId: event.turnId,
      status: this.#projectStatus(current?.status, event),
      kinds,
      createdAt: current?.createdAt ?? event.emittedAt,
      updatedAt: event.emittedAt,
      ...(text === undefined ? {} : { text }),
      latest: event,
    };
    this.#items.set(event.itemId, item);

    if (event.kind === "run.terminal") this.#terminal = clone(event.payload);
  }

  #projectText(current: string | undefined, event: RunItemEvent): string | undefined {
    if (event.kind === "text.delta") return `${current ?? ""}${event.payload.delta}`;
    if (event.kind === "text.completed" && event.payload.text !== undefined) {
      return event.payload.text;
    }
    return current;
  }

  #projectStatus(
    current: RunItemStatus | undefined,
    event: RunItemEvent,
  ): RunItemStatus {
    switch (event.kind) {
      case "turn.started":
      case "text.delta":
        return "streaming";
      case "tool.requested":
        return "requested";
      case "approval.requested":
        return "waiting";
      case "turn.completed":
        return event.payload.outcome;
      case "tool.completed":
        return event.payload.outcome;
      case "approval.resolved":
        return event.payload.decision === "approved" ? "completed" : "canceled";
      case "error.raised":
        return "failed";
      case "text.completed":
      case "artifact.published":
      case "audit.finding":
      case "run.terminal":
        return "completed";
      default:
        return current ?? "streaming";
    }
  }
}

export function projectRunItemStream(
  runId: string,
  events: readonly unknown[],
): RunItemProjection {
  const projector = new RunItemProjector(runId);
  for (const event of events) projector.ingest(event);
  return projector.snapshot();
}
