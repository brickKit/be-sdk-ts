// Subjects, streams, durables and dead-letter subjects (P12.3–P12.5, P12.7; vectors envelope/names).
import { SpecError } from "../errors/specError.js";

const SEGMENT = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const COMPONENT_ID = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

export function validateSubject(subject: string): string[] {
  const segs = subject.split(".");
  const ok = segs.length >= 4 && segs.every((s) => SEGMENT.test(s)) && /^v[1-9][0-9]*$/.test(segs.at(-1)!);
  if (!ok) throw new SpecError("SUBJECT_INVALID", `not <domain>.<name>.<event…>.v<n>: ${JSON.stringify(subject)}`);
  return segs;
}

export function streamFor(subject: string): { stream: string; filter: string } {
  const first = validateSubject(subject)[0]!;
  return { stream: `BE_${first.toUpperCase()}`, filter: `${first}.>` };
}

export const DLQ_STREAM = "BE_DLQ";

export function durableName(componentId: string, subject: string): string {
  if (!COMPONENT_ID.test(componentId)) throw new SpecError("COMPONENT_INVALID", `not a component ID: ${componentId}`);
  validateSubject(subject);
  return `${componentId.replace("/", "_")}__${subject.split(".").join("__")}`;
}

export function dlqSubject(durable: string, subject: string): string {
  return `dlq.${durable}.${subject}`;
}
