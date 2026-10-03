// A temporary component directory (component.yaml with port 0) and an environment for runMain tests.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempComponent(opts: { id?: string; properties?: string; required?: string[]; grpc?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "besdk-comp-"));
  const id = opts.id ?? "sdktest/basic";
  const props = opts.properties ?? `
    AUTHZ_URL: {type: string}
    IAM_URL: {type: string}
    IAM_ISSUER: {type: string}
    TENANT_ID: {type: string}
    LOG_LEVEL: {type: string, default: info}
    HTTP_DEFAULT_TIMEOUT: {type: string, default: 10s}
    SHUTDOWN_GRACE: {type: string, default: 25s}
    DEFAULT_LOCALE: {type: string, default: zh-CN}
    OTEL_BASE_URL: {type: string, default: ""}`;
  const manifest = join(dir, "component.yaml");
  writeFileSync(manifest, `apiVersion: brickkit/v1
kind: Component
metadata: {id: ${id}, version: 3.0.0}
configSchema:
  type: object
  properties:${props}
  required: [${(opts.required ?? []).join(", ")}]
deployment:
  port: 0
  protocol: http
${opts.grpc ? "  extraPorts:\n    - {name: grpc, port: 0, protocol: grpc}\n" : ""}  stopGracePeriodSeconds: 30
`);
  return { dir, manifest, id };
}
