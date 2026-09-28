import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  EventPage,
  HarnessEvent,
  RunState,
  RunStore,
  RunSummary,
} from "./types.js";

interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

interface SqliteRunRow {
  run_id: string;
  goal: string;
  status: RunState["status"];
  round: number;
  event_sequence: number;
  created_at: string;
  updated_at: string;
  snapshot_json: string;
}

interface SqliteEventRow {
  event_json: string;
  state_json?: string;
  sequence?: number;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_run_store",
    up: `
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        round INTEGER NOT NULL,
        event_sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX events_run_occurred_at
        ON events(run_id, occurred_at, sequence);
      CREATE INDEX runs_updated_at
        ON runs(updated_at DESC, run_id ASC);
    `,
    down: `
      DROP INDEX IF EXISTS runs_updated_at;
      DROP INDEX IF EXISTS events_run_occurred_at;
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS runs;
    `,
  },
];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
}

function parseState(raw: string, expectedRunId: string): RunState {
  const value = JSON.parse(raw) as Partial<RunState>;
  if (value.runId !== expectedRunId || value.schemaVersion !== 1) {
    throw new Error(`Invalid snapshot for run ${expectedRunId}.`);
  }
  return value as RunState;
}

function parseEvent(raw: string, expectedRunId: string): HarnessEvent {
  const value = JSON.parse(raw) as Partial<HarnessEvent>;
  if (value.runId !== expectedRunId || typeof value.sequence !== "number") {
    throw new Error(`Invalid event for run ${expectedRunId}.`);
  }
  return value as HarnessEvent;
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Event page limit must be an integer between 1 and 500.");
  }
  return limit;
}

export interface SqliteRunStoreOptions {
  readonly?: boolean;
}

export class SqliteRunStore implements RunStore {
  readonly #database: DatabaseSync;

  constructor(readonly filename: string, options: SqliteRunStoreOptions = {}) {
    if (filename !== ":memory:") {
      mkdirSync(dirname(resolve(filename)), { recursive: true });
    }
    this.#database = new DatabaseSync(filename, {
      open: true,
      readOnly: options.readonly ?? false,
      enableForeignKeyConstraints: true,
    });
    this.#database.exec("PRAGMA busy_timeout = 5000;");
    if (!(options.readonly ?? false)) {
      this.#database.exec("PRAGMA journal_mode = WAL;");
      this.migrate();
    }
  }

  close(): void {
    this.#database.close();
  }

  migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const appliedRows = this.#database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as unknown as Array<{ version: number }>;
    const applied = new Set(appliedRows.map(({ version }) => version));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.#transaction(() => {
        this.#database.exec(migration.up);
        this.#database
          .prepare(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, new Date().toISOString());
      });
    }
  }

  rollbackLastMigration(): number | undefined {
    const row = this.#database
      .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
      .get() as unknown as { version: number } | undefined;
    if (!row) return undefined;
    const migration = MIGRATIONS.find(({ version }) => version === row.version);
    if (!migration) throw new Error(`No reversible migration registered for version ${row.version}.`);

    this.#transaction(() => {
      this.#database.exec(migration.down);
      this.#database.prepare("DELETE FROM schema_migrations WHERE version = ?").run(row.version);
    });
    return row.version;
  }

  async load(runId: string): Promise<RunState | undefined> {
    assertRunId(runId);
    const row = this.#database
      .prepare("SELECT snapshot_json FROM runs WHERE run_id = ?")
      .get(runId) as unknown as { snapshot_json: string } | undefined;
    if (!row) return this.#recoverSnapshot(runId);

    try {
      return clone(parseState(row.snapshot_json, runId));
    } catch {
      return this.#recoverSnapshot(runId);
    }
  }

  async commit(state: RunState, event: HarnessEvent): Promise<void> {
    assertRunId(state.runId);
    if (event.runId !== state.runId) {
      throw new Error("State and event must belong to the same run.");
    }
    if (event.sequence !== state.eventSequence) {
      throw new Error("State eventSequence must equal the committed event sequence.");
    }

    const stateJson = JSON.stringify(state);
    const eventJson = JSON.stringify(event);
    this.#transaction(() => {
      this.#database
        .prepare(`
          INSERT INTO runs(
            run_id, schema_version, goal, status, round, event_sequence,
            created_at, updated_at, snapshot_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            goal = excluded.goal,
            status = excluded.status,
            round = excluded.round,
            event_sequence = excluded.event_sequence,
            updated_at = excluded.updated_at,
            snapshot_json = excluded.snapshot_json
        `)
        .run(
          state.runId,
          state.schemaVersion,
          state.goal,
          state.status,
          state.round,
          state.eventSequence,
          state.createdAt,
          state.updatedAt,
          stateJson,
        );
      this.#database
        .prepare(`
          INSERT INTO events(
            run_id, sequence, event_id, occurred_at, type, event_json, state_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          event.runId,
          event.sequence,
          event.id,
          event.occurredAt,
          event.type,
          eventJson,
          stateJson,
        );
    });
  }

  async readEvents(runId: string): Promise<HarnessEvent[]> {
    const events: HarnessEvent[] = [];
    let cursor = 0;
    for (;;) {
      const page = await this.readEventPage(runId, { afterSequence: cursor, limit: 500 });
      events.push(...page.events);
      if (page.nextCursor === undefined) return events;
      cursor = page.nextCursor;
    }
  }

  async readEventPage(
    runId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<EventPage> {
    assertRunId(runId);
    const afterSequence = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("Event cursor must be a non-negative safe integer.");
    }
    const limit = pageLimit(options.limit);
    const rows = this.#database
      .prepare(`
        SELECT event_json
        FROM events
        WHERE run_id = ? AND sequence > ?
        ORDER BY sequence ASC
        LIMIT ?
      `)
      .all(runId, afterSequence, limit + 1) as unknown as SqliteEventRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const events = pageRows.map(({ event_json }) => parseEvent(event_json, runId));
    const lastSequence = events.at(-1)?.sequence;
    return {
      events: clone(events),
      ...(hasMore && lastSequence !== undefined ? { nextCursor: lastSequence } : {}),
    };
  }

  async listRuns(options: { limit?: number } = {}): Promise<RunSummary[]> {
    const limit = pageLimit(options.limit);
    const rows = this.#database
      .prepare(`
        SELECT run_id, goal, status, round, event_sequence, created_at, updated_at
        FROM runs
        ORDER BY updated_at DESC, run_id ASC
        LIMIT ?
      `)
      .all(limit) as unknown as SqliteRunRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      goal: row.goal,
      status: row.status,
      round: row.round,
      eventSequence: row.event_sequence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  integrityCheck(): string {
    const row = this.#database.prepare("PRAGMA quick_check").get() as unknown as {
      quick_check: string;
    };
    return row.quick_check;
  }

  #recoverSnapshot(runId: string): RunState | undefined {
    const rows = this.#database
      .prepare(`
        SELECT state_json, sequence
        FROM events
        WHERE run_id = ?
        ORDER BY sequence DESC
      `)
      .all(runId) as unknown as SqliteEventRow[];

    for (const row of rows) {
      if (!row.state_json) continue;
      try {
        const state = parseState(row.state_json, runId);
        this.#database
          .prepare(`
            UPDATE runs
            SET schema_version = ?, goal = ?, status = ?, round = ?, event_sequence = ?,
                created_at = ?, updated_at = ?, snapshot_json = ?
            WHERE run_id = ?
          `)
          .run(
            state.schemaVersion,
            state.goal,
            state.status,
            state.round,
            state.eventSequence,
            state.createdAt,
            state.updatedAt,
            row.state_json,
            runId,
          );
        return clone(state);
      } catch {
        // Continue to the preceding transaction checkpoint.
      }
    }
    return undefined;
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
