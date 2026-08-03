import { Migration } from "../lib/migration.js";
import InitialSchema from "./0001-initial-schema.js";

/**
 * Every migration, in ascending version order. Append new ones to the end and
 * never renumber or edit a released migration: databases in the wild have
 * already recorded the old version in `schema_migrations`.
 */
const migrations: readonly Migration[] = [InitialSchema];

export default migrations;
