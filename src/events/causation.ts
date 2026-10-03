// Causation and hop count of an event published inside a unit of work (P12.8; vectors envelope/derive).
export type PublishContext =
  | { kind: "event"; handled: { id: string; hopCount: number } }
  | { kind: "queued_job"; job: { causationId: string; hopCount: number } }
  | { kind: string };

export function deriveCausation(c: PublishContext): { causationId: string; hopCount: number } {
  if (c.kind === "event" && "handled" in c) return { causationId: c.handled.id, hopCount: c.handled.hopCount + 1 };
  if (c.kind === "queued_job" && "job" in c) return { causationId: c.job.causationId, hopCount: c.job.hopCount };
  return { causationId: "", hopCount: 0 };
}
