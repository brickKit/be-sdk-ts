// The component's event contracts (P12.2): contracts/events/*.events.json give each subject its aggregate type
// (`x-aggregate-type`), whether it is a transaction document, and the payload's JSON Schema.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/** P12.2 + stage-B ruling: a payload above 64 KiB is refused at publish (content that large goes by claim check). */
export const MAX_PAYLOAD_BYTES = 64 << 10;

export interface EventContract {
  subject: string;
  aggregateType: string;
  transactionDocument: boolean;
  file: string;
  /** the payload's problems; empty when it conforms */
  check(payload: unknown): string[];
}

interface ContractFile {
  events: { subject: string; "x-aggregate-type": string; "x-transaction-document"?: boolean; payload: object }[];
}

export class EventContracts {
  private readonly bySubject = new Map<string, EventContract>();

  static load(contractsDir: string | undefined): EventContracts {
    const c = new EventContracts();
    const dir = contractsDir ? join(contractsDir, "events") : undefined;
    if (!dir || !existsSync(dir)) return c;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    (addFormats as unknown as (a: Ajv2020) => void)(ajv);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".events.json")).sort()) {
      const doc = JSON.parse(readFileSync(join(dir, file), "utf8")) as ContractFile;
      for (const e of doc.events ?? []) {
        const validate = ajv.compile(e.payload);
        c.bySubject.set(e.subject, {
          subject: e.subject, aggregateType: e["x-aggregate-type"], transactionDocument: e["x-transaction-document"] === true, file,
          check: (payload) => {
            if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) return ["payload exceeds 64 KiB; send a claim check (P12.2)"];
            return validate(payload) ? [] : (validate.errors ?? []).map((x) => `${x.instancePath || "/"} ${x.message ?? "invalid"}`);
          },
        });
      }
    }
    return c;
  }

  get(subject: string): EventContract | undefined {
    return this.bySubject.get(subject);
  }
}
