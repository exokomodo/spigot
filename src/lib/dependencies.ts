import Database from "./database.js";

export default interface Dependencies {
  readonly db: Database;
}
