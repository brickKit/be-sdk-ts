// A file-delivered secret (P2.7, P2.9): read when used, re-read when the file's modification time or size
// changes (checked at most RECHECK_MS apart, and by a watcher every POLL_MS), last good value kept on failure.
import { readFileSync, statSync } from "node:fs";
import { ConfigError } from "./configError.js";
import { secretText } from "./parse.js";

const RECHECK_MS = 1_000;
const POLL_MS = 10_000;

export interface SecretObserver {
  changed(key: string): void;
  failed(key: string, err: unknown): void;
}

export class Secret {
  readonly key: string;
  readonly path: string;
  private value: Buffer;
  private stamp: string;
  private checkedAt = Date.now();
  private observer: SecretObserver | undefined;
  private listeners: (() => void)[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(key: string, path: string) {
    this.key = key;
    this.path = path;
    try {
      this.stamp = stampOf(path);
      this.value = readFileSync(path);
    } catch (e) {
      throw new ConfigError("CONFIG_INVALID", key, `cannot read the secret file: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
    }
    secretText(key, this.value.toString("utf8"), true);
  }

  /** The text value, exactly one trailing newline removed. */
  current(): string {
    this.maybeReload();
    return secretText(this.key, this.value.toString("utf8"), false) ?? "";
  }

  /** A component's own binary secret, byte for byte. */
  bytes(): Buffer {
    this.maybeReload();
    return Buffer.from(this.value);
  }

  /** Called after every successful re-read; returns an unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((l) => l !== fn));
  }

  /** Starts the background check and reports changes and failures (logger, be_secret_reload_failures_total). */
  watch(observer: SecretObserver): void {
    this.observer = observer;
    this.timer ??= setInterval(() => this.reload(), POLL_MS).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Re-reads when the file changed; true when a new value was taken. */
  reload(): boolean {
    this.checkedAt = Date.now();
    try {
      const stamp = stampOf(this.path);
      if (stamp === this.stamp) return false;
      const next = readFileSync(this.path);
      if (secretText(this.key, next.toString("utf8"), false) === undefined) throw new Error("the secret file is empty");
      this.value = next;
      this.stamp = stamp;
    } catch (e) {
      this.observer?.failed(this.key, e);
      return false;
    }
    this.observer?.changed(this.key);
    for (const l of this.listeners) l();
    return true;
  }

  private maybeReload(): void {
    if (Date.now() - this.checkedAt >= RECHECK_MS) this.reload();
  }
}

function stampOf(path: string): string {
  const s = statSync(path);
  if (!s.isFile()) throw Object.assign(new Error("not a file"), { code: "EISDIR" });
  return `${s.mtimeMs}:${s.size}`;
}
