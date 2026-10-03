import { defineConfig } from "vitest/config";

// Two projects: `unit` runs offline (vectors, pure logic, in-process servers);
// `integration` needs the throwaway PostgreSQL / NATS containers that `make test-integration`
// starts, and fails (never skips) when their addresses are missing. Its files share streams on one NATS, so it
// runs with --no-file-parallelism (a per-project fileParallelism is not honoured by vitest 3).
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"], testTimeout: 20_000 } },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
