export interface Config {
  host: string;
  port: number;
  nodeEnv: string;
  databaseFilePath: string;
}

export function loadConfig(): Config {
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: parseInt(process.env.PORT ?? "3000", 10),
    nodeEnv: process.env.NODE_ENV ?? "development",
    databaseFilePath: process.env.DATABASE_FILE_PATH ?? "database.sqlite",
  };
}
