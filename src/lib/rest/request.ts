import express from "express";

export const DEFAULT_DEPENDENCIES_KEY = "deps";
export type DefaultDependenciesKey = typeof DEFAULT_DEPENDENCIES_KEY;

type Request<TDependencies, TKey extends string = DefaultDependenciesKey> = express.Request & {
  [K in TKey]: TDependencies;
};

export function fromExpressRequest<TDependencies, TKey extends string = DefaultDependenciesKey>(
  req: express.Request,
  dependencies: TDependencies,
  key: TKey = DEFAULT_DEPENDENCIES_KEY as TKey
): Request<TDependencies, TKey> {
  const request = req as Request<TDependencies, TKey>;
  Object.assign(request, { [key]: dependencies });
  return request;
}

export default Request;
