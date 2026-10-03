// What one process shares between its members (P19.3): the trace exporter and propagator, the JWKS verifier and
// the bundle. Standalone, the platform is built from the component's own configuration.
import type { Logger } from "pino";
import { BundleSource } from "../auth/bundle.js";
import { JwtVerifier } from "../auth/jwt.js";
import type { Config } from "../config/config.js";
import { errorFields } from "../log/logger.js";
import { Telemetry } from "../obs/telemetry.js";

export class Platform {
  readonly telemetry: Telemetry;
  readonly verifier: JwtVerifier | undefined;
  readonly bundle: BundleSource | undefined;

  constructor(config: Config, logger: Logger) {
    this.telemetry = Telemetry.create(config.orDefault("OTEL_BASE_URL", (c) => c.string("OTEL_BASE_URL", "")!, ""), {});
    const iamUrl = has(config, "IAM_URL") ? config.familyAddress("IAM_URL") : undefined;
    this.verifier = iamUrl && has(config, "IAM_ISSUER") && has(config, "TENANT_ID")
      ? new JwtVerifier({
          jwksUrl: `${iamUrl}/.well-known/jwks.json`, issuer: config.require("IAM_ISSUER"), audience: config.require("TENANT_ID"),
          onFetchError: (e) => logger.warn(errorFields(e), "jwks_fetch_failed"),
        })
      : undefined;
    const authzUrl = has(config, "AUTHZ_URL") ? config.familyAddress("AUTHZ_URL") : undefined;
    this.bundle = authzUrl
      ? new BundleSource({
          authzUrl,
          onRefused: (why) => logger.error({ error: why }, "authz_bundle_refused"),
          onFetchError: (e) => logger.warn(errorFields(e), "authz_bundle_fetch_failed"),
        })
      : undefined;
  }

  async shutdown(): Promise<void> {
    await this.telemetry.shutdown();
  }
}

function has(c: Config, key: string): boolean {
  return c.declares(key) && c.has(key);
}
