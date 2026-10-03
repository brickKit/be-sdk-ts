// Batch limits (P7.10): every repeated field of a request accepts at most `(be.v1.max_items)` items, 500 when the
// option is absent. The limits come from the descriptor (which fields are repeated, their TS property names) and
// ts-proto's option table (`options.messages.<Msg>.fields.<field>.max_items`, nested messages under `.nested`,
// r1-03b). Rules are compiled once per method at registration; a request costs one walk over the fields that
// hold arrays or messages.
import type { MessageEntry, ProtoMetadataLike } from "./descriptors.js";
import { messagesOf } from "./descriptors.js";

export const DEFAULT_MAX_ITEMS = 500;
const LABEL_REPEATED = 3;
const TYPE_MESSAGE = 11;

interface Rule {
  field: string;
  prop: string;
  /** set for repeated fields */
  max?: number;
  /** the field's message type, to descend into */
  message?: string;
}

export interface BatchViolation {
  /** the proto path of the field: `ids`, `filter.sku_ids`, `items[2].codes` */
  field: string;
  max: number;
  got: number;
}

export type BatchCheck = (request: unknown) => BatchViolation | undefined;

/**
 * The checker for one request type. Map fields are skipped (ts-proto decodes them to objects and they are not
 * lists of IDs), and so are google.protobuf types, which ts-proto turns into plain values (Struct, Timestamp).
 */
export function batchCheck(schema: ProtoMetadataLike, inputType: string): BatchCheck {
  const messages = messagesOf(schema);
  const compiled = new Map<string, Rule[]>();
  const rulesOf = (fq: string): Rule[] => {
    let rules = compiled.get(fq);
    if (!rules) {
      const entry = messages.get(fq);
      rules = entry && !fq.startsWith(".google.protobuf.") ? compile(entry, messages) : [];
      compiled.set(fq, rules);
    }
    return rules;
  };
  for (const fq of messages.keys()) rulesOf(fq); // compile eagerly: no work left for the request path
  return (request) => walk(rulesOf, inputType, request, "");
}

function compile(entry: MessageEntry, messages: Map<string, MessageEntry>): Rule[] {
  const rules: Rule[] = [];
  for (const f of entry.desc.field) {
    const isMessage = f.type === TYPE_MESSAGE;
    if (isMessage && messages.get(f.typeName)?.desc.options?.mapEntry) continue;
    const rule: Rule = { field: f.name, prop: f.jsonName || f.name };
    if (f.label === LABEL_REPEATED) {
      const v = entry.opts?.fields?.[f.name]?.["max_items"];
      rule.max = typeof v === "number" && v > 0 ? v : DEFAULT_MAX_ITEMS;
    }
    if (isMessage) rule.message = f.typeName;
    if (rule.max !== undefined || rule.message !== undefined) rules.push(rule);
  }
  return rules;
}

function walk(rulesOf: (fq: string) => Rule[], fq: string, value: unknown, prefix: string): BatchViolation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  for (const r of rulesOf(fq)) {
    const v = (value as Record<string, unknown>)[r.prop];
    if (r.max !== undefined) {
      if (!Array.isArray(v)) continue;
      if (v.length > r.max) return { field: prefix + r.field, max: r.max, got: v.length };
      if (r.message === undefined) continue;
      for (let i = 0; i < v.length; i++) {
        const hit = walk(rulesOf, r.message, v[i], `${prefix}${r.field}[${i}].`);
        if (hit) return hit;
      }
    } else if (r.message !== undefined) {
      const hit = walk(rulesOf, r.message, v, `${prefix}${r.field}.`);
      if (hit) return hit;
    }
  }
  return undefined;
}
