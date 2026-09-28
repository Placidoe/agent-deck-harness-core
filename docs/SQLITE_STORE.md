# SQLite Run Store

`SqliteRunStore` is the production persistence adapter for Harness state. It uses Node's built-in `node:sqlite` module and therefore requires Node `22.13` or newer. The JSON-file store remains available for examples and portable tests.

```ts
const store = new SqliteRunStore(".harness/runs.sqlite");
const harness = new AgentHarness({ store });
```

## Transaction boundary

Every Harness transition calls `RunStore.commit(state, event)`. SQLite updates the current snapshot and appends its event under one `BEGIN IMMEDIATE` transaction. Product subscribers are notified only after that transaction commits.

The event row also retains the resulting state checkpoint. This is intentional: if the mutable `runs.snapshot_json` value becomes unreadable, `load()` walks backward through committed checkpoints, repairs the current snapshot, and resumes from the newest valid state.

## Schema migrations

Migrations are ordered, versioned records in `schema_migrations`. Startup applies unapplied migrations transactionally. `rollbackLastMigration()` reverses the latest migration when a down migration is registered; destructive rollback is an explicit maintenance operation and is never run automatically.

## Efficient reads

- `listRuns({ limit })` selects metadata columns only and never deserializes snapshots or histories.
- `readEventPage(runId, { afterSequence, limit })` pages forward using the stable per-run sequence cursor.
- `readEvents(runId)` remains a convenience method and internally walks cursor pages.
- `integrityCheck()` exposes SQLite `PRAGMA quick_check` for diagnostics.

The next M1 slice adds optimistic concurrency and stale-writer recovery on top of this transaction boundary.
