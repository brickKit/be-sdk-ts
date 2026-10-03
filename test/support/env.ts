// Addresses of the throwaway containers `make test-integration` starts. Missing = a failure, never a skip.
export function requireEnv(name: "BE_TEST_PG16" | "BE_TEST_PG14" | "BE_TEST_NATS"): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: run the integration tests with \`make test-integration\``);
  return v;
}
