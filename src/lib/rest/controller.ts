import path from "node:path";
import express from "express";
import Application from "./application.js";
import Request, { DefaultDependenciesKey } from "./request.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface Route<TDependencies, TKey extends string = DefaultDependenciesKey> {
  path: string;
  method: HttpMethod;
  handler: (req: Request<TDependencies, TKey>, res: express.Response) => void;
}

export interface Controller<TDependencies, TKey extends string = DefaultDependenciesKey> {
  basePath: string;
  routes: Route<TDependencies, TKey>[];
}

type ExpressHandler = (req: express.Request, res: express.Response) => void;

export function registerController<TDependencies, TKey extends string = DefaultDependenciesKey>(
  app: Application<TDependencies, TKey>,
  controller: Controller<TDependencies, TKey>
) {
  controller.routes.forEach((route) => {
    const fullPath = path.join(controller.basePath, route.path);
    switch (route.method) {
      case "GET":
        {
          app.get(fullPath, route.handler as ExpressHandler);
        }
        break;
      case "POST":
        {
          app.post(fullPath, route.handler as ExpressHandler);
        }
        break;
      case "PUT":
        {
          app.put(fullPath, route.handler as ExpressHandler);
        }
        break;
      case "DELETE":
        {
          app.delete(fullPath, route.handler as ExpressHandler);
        }
        break;
      case "PATCH":
        {
          app.patch(fullPath, route.handler as ExpressHandler);
        }
        break;
      default: {
        throw new Error(`Unsupported HTTP method: ${route.method}`);
      }
    }
  });
}
