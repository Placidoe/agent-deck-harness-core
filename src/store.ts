import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HarnessEvent, RunState, RunStore } from "./types.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
}

export class MemoryRunStore implements RunStore {
  readonly #states = new Map<string, RunState>();
  readonly #events = new Map<string, HarnessEvent[]>();

  async load(runId: string): Promise<RunState | undefined> {
    const state = this.#states.get(runId);
    return state ? clone(state) : undefined;
  }

  async save(state: RunState): Promise<void> {
    this.#states.set(state.runId, clone(state));
  }

  async append(event: HarnessEvent): Promise<void> {
    const events = this.#events.get(event.runId) ?? [];
    events.push(clone(event));
    this.#events.set(event.runId, events);
  }

  async commit(state: RunState, event: HarnessEvent): Promise<void> {
    const events = this.#events.get(event.runId) ?? [];
    events.push(clone(event));
    this.#events.set(event.runId, events);
    this.#states.set(state.runId, clone(state));
  }

  async readEvents(runId: string): Promise<HarnessEvent[]> {
    return clone(this.#events.get(runId) ?? []);
  }
}

export class JsonFileRunStore implements RunStore {
  constructor(readonly rootDirectory: string) {}

  async load(runId: string): Promise<RunState | undefined> {
    assertRunId(runId);
    try {
      const raw = await readFile(this.#snapshotPath(runId), "utf8");
      return JSON.parse(raw) as RunState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(state: RunState): Promise<void> {
    assertRunId(state.runId);
    const directory = this.#runDirectory(state.runId);
    await mkdir(directory, { recursive: true });
    const target = this.#snapshotPath(state.runId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async append(event: HarnessEvent): Promise<void> {
    assertRunId(event.runId);
    const directory = this.#runDirectory(event.runId);
    await mkdir(directory, { recursive: true });
    await appendFile(this.#eventPath(event.runId), `${JSON.stringify(event)}\n`, "utf8");
  }

  async commit(state: RunState, event: HarnessEvent): Promise<void> {
    await this.append(event);
    await this.save(state);
  }

  async readEvents(runId: string): Promise<HarnessEvent[]> {
    assertRunId(runId);
    try {
      const raw = await readFile(this.#eventPath(runId), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as HarnessEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  #runDirectory(runId: string): string {
    return join(this.rootDirectory, "runs", runId);
  }

  #snapshotPath(runId: string): string {
    return join(this.#runDirectory(runId), "snapshot.json");
  }

  #eventPath(runId: string): string {
    return join(this.#runDirectory(runId), "events.jsonl");
  }
}
