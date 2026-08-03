import sqlite3 from "sqlite3";
import * as sqlite from "sqlite";
import { runMigrations } from "./migration.js";

export default interface Database {
  readonly instance: sqlite.Database;
}

/**
 * Opens the database, enforces foreign keys on the connection and brings the
 * schema up to date. Every migration is idempotent, so this is safe on boot.
 */
export async function loadDatabase(dbFilePath: string): Promise<Database> {
  const instance = await sqlite.open({
    filename: dbFilePath,
    driver: sqlite3.Database,
  });
  // Off by default in SQLite, and it is per-connection rather than per-database.
  await instance.exec("PRAGMA foreign_keys = ON;");
  const applied = await runMigrations(instance);
  for (const migration of applied) {
    console.log(`Applied migration ${migration.version} (${migration.name})`);
  }
  return {
    instance,
  };
}
