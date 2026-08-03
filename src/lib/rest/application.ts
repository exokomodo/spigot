import express from "express";
import { DEFAULT_DEPENDENCIES_KEY, DefaultDependenciesKey, fromExpressRequest } from "./request.js";

type Application<
  TDependencies,
  TKey extends string = DefaultDependenciesKey,
> = express.Application & { [K in TKey]: TDependencies };

export function fromExpressApp<TDependencies, TKey extends string = DefaultDependenciesKey>(
  app: express.Application,
  dependencies: TDependencies,
  key: TKey = DEFAULT_DEPENDENCIES_KEY as TKey
): Application<TDependencies, TKey> {
  const application = app as Application<TDependencies, TKey>;
  Object.assign(application, { [key]: dependencies });
  application.use((req, _, next) => {
    fromExpressRequest(req, dependencies, key);
    next();
  });
  return application;
}

export default Application;
