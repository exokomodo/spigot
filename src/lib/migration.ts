import * as sqlite from "sqlite";
import migrations from "../migrations/index.js";

/**
 * A single forward-only schema change. `up` may contain several statements; it
 * runs as one unit inside a transaction, so either all of it lands or none.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

/** Bookkeeping table. Created with IF NOT EXISTS so boot is always idempotent. */
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

function assertOrderedAndUnique(candidates: readonly Migration[]): void {
  candidates.reduce((previous: Migration | undefined, migration) => {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(
        `Migration "${migration.name}" has version ${migration.version}; ` +
          `versions must be positive integers. Fix it in src/migrations/index.ts.`
      );
    }
    if (previous !== undefined && migration.version <= previous.version) {
      throw new Error(
        `Migration "${migration.name}" (version ${migration.version}) is not ordered after ` +
          `"${previous.name}" (version ${previous.version}). ` +
          `List migrations in ascending, unique version order in src/migrations/index.ts.`
      );
    }
    return migration;
  }, undefined);
}

/** Versions already recorded in `schema_migrations`, as a set for lookup. */
async function appliedVersions(db: sqlite.Database): Promise<ReadonlySet<number>> {
  const rows = await db.all<{ version: number }[]>(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  return new Set(rows.map((row) => row.version));
}

async function apply(db: sqlite.Database, migration: Migration): Promise<void> {
  await db.exec("BEGIN");
  try {
    await db.exec(migration.up);
    await db.run("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", [
      migration.version,
      migration.name,
    ]);
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw new Error(
      `Migration ${migration.version} ("${migration.name}") failed and was rolled back: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

/**
 * Applies every migration the database has not seen yet, in version order, and
 * returns the ones that were applied. Safe to run on every boot: an up-to-date
 * database returns an empty list.
 */
export async function runMigrations(
  db: sqlite.Database,
  candidates: readonly Migration[] = migrations
): Promise<readonly Migration[]> {
  assertOrderedAndUnique(candidates);
  await db.exec(SCHEMA_MIGRATIONS_DDL);

  const applied = await appliedVersions(db);
  const pending = candidates.filter((migration) => !applied.has(migration.version));
  for (const migration of pending) {
    await apply(db, migration);
  }
  return pending;
}
