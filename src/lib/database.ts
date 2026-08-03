import sqlite3 from "sqlite3";
import * as sqlite from "sqlite";

export default interface Database {
  instance: sqlite.Database;
}

export async function loadDatabase(dbFilePath: string): Promise<Database> {
  const db = await sqlite.open({
    filename: dbFilePath,
    driver: sqlite3.Database,
  });
  return {
    instance: db,
  };
}
