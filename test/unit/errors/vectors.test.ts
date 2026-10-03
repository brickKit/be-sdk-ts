import { describe, expect } from "vitest";
import { runVectors } from "../../support/vectors.js";
import { codeNumber, httpStatus, logLevel } from "../../../src/errors/codes.js";
import { BeError, platformError } from "../../../src/errors/beError.js";
import { problemBody, restoreHttp, retryAfterHeader, validateReasonName } from "../../../src/errors/problem.js";
import { classifySqlState } from "../../../src/errors/sqlstate.js";

const view = (e: BeError) => ({ code: e.code, reason: e.reason || null, domain: e.domain ?? null, http: (e as { httpStatus?: number }).httpStatus ?? httpStatus(e.code, e.reason, e.domain) });

describe("errors vectors", () => {
  runVectors("errors", "codes", {
    grpc_to_http: (i) => ({ number: codeNumber(i.code), http: httpStatus(i.code, i.reason, i.domain) }),
    be_reason: (i) => {
      const e = platformError(i.reason);
      return { code: e.code, domain: e.domain, http: httpStatus(e.code, e.reason, e.domain) };
    },
    restore_http: (i) => view(restoreHttp(i.status, i.problem)),
  });
  runVectors("errors", "sqlstate", {
    classify: (i) => {
      const r = classifySqlState(i.sqlstate, {
        attempt: i.attempt ?? 1,
        context: i.context ?? "none",
        componentMapping: i.component_mapping ? new BeError(i.component_mapping.code, i.component_mapping.reason, { domain: i.component_mapping.domain }) : undefined,
      });
      return r.action === "retry" ? { action: "retry", base_delay_ms: r.baseDelayMs } : { action: "fail", ...view(r.error) };
    },
  });
  runVectors("errors", "levels", { log_level: (i) => ({ level: logLevel(i.code) }) });
  runVectors("errors", "problem", {
    problem: (i, c) => {
      const e = i.error;
      const err = e.code
        ? new BeError(e.code, e.reason, { domain: e.domain, metadata: e.metadata, violations: e.violations, message: e.internal_message })
        : new Error(e.internal_message ?? "unclassified");
      const p = problemBody(err, { path: i.request.path, requestId: i.request.request_id, traceId: i.request.trace_id }, { locale: "en" });
      for (const s of c.expected.detail_must_not_contain ?? []) expect(p.body.detail).not.toContain(s);
      const { title, detail, ...rest } = p.body;
      expect(typeof title).toBe("string");
      expect(typeof detail).toBe("string");
      const out: Record<string, unknown> = { content_type: p.contentType, body: rest };
      if (c.expected.detail_must_not_contain) out.detail_must_not_contain = c.expected.detail_must_not_contain;
      return out;
    },
    retry_after: (i) => ({ header: retryAfterHeader(i.code, i.retry_delay_ms) }),
    reason_name: (i) => (validateReasonName(i.reason, i.domain), { valid: true }),
  });
});
