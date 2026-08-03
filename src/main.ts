import express from "express";
import { loadConfig } from "./lib/config.js";
import { loadDatabase } from "./lib/database.js";
import Dependencies from "./lib/dependencies.js";
import { registerController } from "./lib/rest/controller.js";
import { fromExpressApp } from "./lib/rest/application.js";
import IndexController from "./controllers/index.js";

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

  app.listen(config.port, config.host, () => {
    console.log(`Server is running on http://${config.host}:${config.port}`);
  });
}

await main();
