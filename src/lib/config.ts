export interface Config {
  port: number;
  nodeEnv: string;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT ?? "3000", 10),
    nodeEnv: process.env.NODE_ENV ?? "development",
  };
}
