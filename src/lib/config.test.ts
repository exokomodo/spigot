import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  afterEach(() => {
    delete process.env.PORT;
    delete process.env.NODE_ENV;
  });

  it("returns default port when PORT is not set", () => {
    delete process.env.PORT;
    const config = loadConfig();
    expect(config.port).toBe(3000);
  });

  it("reads PORT from environment", () => {
    process.env.PORT = "8080";
    const config = loadConfig();
    expect(config.port).toBe(8080);
  });

  it("returns default nodeEnv when NODE_ENV is not set", () => {
    delete process.env.NODE_ENV;
    const config = loadConfig();
    expect(config.nodeEnv).toBe("development");
  });

  it("reads NODE_ENV from environment", () => {
    process.env.NODE_ENV = "production";
    const config = loadConfig();
    expect(config.nodeEnv).toBe("production");
  });
});
