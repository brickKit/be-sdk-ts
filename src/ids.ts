// Identifiers (P11.5): UUIDv7, canonical lower-case 36-character form; `idTime` is the embedded millisecond time.
import { v7 } from "uuid";
import { SpecError } from "./errors/specError.js";

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newId(): string {
  return v7();
}

/** Validates and normalises an id (upper case accepted); anything else is ID_INVALID. */
export function parseId(id: string): string {
  const lower = id.toLowerCase();
  if (!V7.test(lower)) throw new SpecError("ID_INVALID", `not a UUIDv7: ${JSON.stringify(id)}`);
  return lower;
}

export function idTime(id: string): Date {
  const hex = parseId(id).replace(/-/g, "").slice(0, 12);
  return new Date(Number.parseInt(hex, 16));
}
