import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests are TypeScript and live beside the code they cover, so the source
    // tree is the whole story. An allowlist rather than a list of exclusions:
    // vitest's default include is broad enough to sweep up compiled copies in
    // build/ and whole checkouts of this repo under .claude/worktrees/, which
    // meant a run after `make build` collected the same test several times over
    // and reported the total as though it were real coverage.
    include: ["src/**/*.test.ts"],
  },
});
