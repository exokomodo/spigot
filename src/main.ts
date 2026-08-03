import path from "node:path";
import express from "express";
import { loadConfig } from "./lib/config.js";
import { loadDatabase } from "./lib/database.js";
import Dependencies from "./lib/dependencies.js";
import { PUBLIC_DIRECTORY } from "./lib/html/template.js";
import { registerController } from "./lib/rest/controller.js";
import { fromExpressApp } from "./lib/rest/application.js";
import ApiFeedsController from "./controllers/api/feeds.js";
import FeedsController from "./controllers/feeds.js";
import PagesController from "./controllers/pages.js";

async function main() {
  const config = loadConfig();
  console.log(`Server is running in ${config.nodeEnv} mode on port ${config.port}`);

  const dependencies: Dependencies = {
    db: await loadDatabase(config.databaseFilePath),
  };
  const app = fromExpressApp(express(), dependencies);

  // Both ship with Express 5. The form posts urlencoded; the API takes JSON.
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use("/vendor", express.static(path.join(PUBLIC_DIRECTORY, "vendor")));

  for (const controller of [ApiFeedsController, PagesController, FeedsController]) {
    registerController(app, controller);
  }

  app.listen(config.port, config.host, () => {
    console.log(`Server is running on http://${config.host}:${config.port}`);
  });
}

await main();
