import express from "express";
import { loadConfig } from "./lib/config";
import { loadDatabase } from "./lib/database";
import Dependencies from "./lib/dependencies";
import { registerController } from "./lib/rest/controller";
import { fromExpressApp } from "./lib/rest/application";
import IndexController from "./controllers/index";

async function main() {
  const config = loadConfig();
  console.log(`Server is running in ${config.nodeEnv} mode on port ${config.port}`);

  const dependencies: Dependencies = {
    db: await loadDatabase(config.databaseFilePath),
  };
  const app = fromExpressApp(express(), dependencies);

  app.use((req, res, next) => {
    next();
  });

  for (const controller of [IndexController]) {
    registerController(app, controller);
  }

  app.listen(config.port, () => {
    console.log(`Server is running on http://localhost:${config.port}`);
  });
}

await main();
