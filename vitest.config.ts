import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "node:path";

export default defineConfig({
  test: {
    testTimeout: 120_000,
    env: {
      AUDIT_DIR: path.join(os.tmpdir(), "poster-mcp-test-audit"),
      PUBLIC_BASE_URL: "http://localhost:3210",
      WRITE_DEFAULT_ACCOUNTS: "cafe-04",
    },
  },
});
