// The authorization bundle (P6.1): GET {AUTHZ_URL}/authz/v2/bundle with ETag, every 15 s; before the first load
// a backoff from 0.5 s doubling to 15 s; 3 s per fetch; a poke fetches at once; a failed fetch or a refused
// bundle keeps the one held (fail-static, E1).
import { acceptBundle, type Bundle } from "./decide.js";
import { Wakeable } from "../util/sleep.js";

export interface BundleSourceOptions {
  authzUrl: string;
  pollMs?: number;
  firstRetryMs?: number;
  onRefused?: (why: string) => void;
  onFetchError?: (err: unknown) => void;
}

const FETCH_TIMEOUT_MS = 3_000;

export class BundleSource {
  private readonly o: BundleSourceOptions;
  private bundle: Bundle | undefined;
  private etag = "";
  private loadedAt = 0;
  private readonly wakeable = new Wakeable();
  private readonly waiters: (() => void)[] = [];

  constructor(o: BundleSourceOptions) {
    this.o = o;
  }

  current(): Bundle | undefined {
    return this.bundle;
  }

  /** seconds since the bundle held was last confirmed */
  ageSeconds(): number {
    return this.loadedAt === 0 ? 0 : (Date.now() - this.loadedAt) / 1000;
  }

  /** Resolves once a first bundle is held. */
  ready(): Promise<void> {
    return this.bundle ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }

  /** A poke on infra.authz.changed.v1 (P12.10). */
  poke(): void {
    this.wakeable.poke();
  }

  /** One conditional GET; true when a usable bundle is held after it. */
  async fetchOnce(): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch(`${this.o.authzUrl}/authz/v2/bundle`, {
        headers: this.etag ? { "if-none-match": this.etag } : {},
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      this.o.onFetchError?.(e);
      return false;
    }
    if (res.status === 304 && this.bundle) {
      this.loadedAt = Date.now();
      return true;
    }
    if (res.status !== 200) {
      this.o.onFetchError?.(new Error(`bundle answered ${res.status}`));
      return false;
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (e) {
      this.o.onFetchError?.(e);
      return false;
    }
    const b = acceptBundle(raw);
    if (!b) {
      this.o.onRefused?.(`bundle contract ${JSON.stringify((raw as { contract?: unknown })?.contract)} is not authz/2.x`);
      return false;
    }
    this.bundle = b;
    this.etag = res.headers.get("etag") ?? "";
    this.loadedAt = Date.now();
    for (const w of this.waiters.splice(0)) w();
    return true;
  }

  /** The polling loop; returns when `signal` aborts. Run it under the supervisor. */
  async run(signal: AbortSignal): Promise<void> {
    const poll = this.o.pollMs ?? 15_000;
    let retry = this.o.firstRetryMs ?? 500;
    while (!signal.aborted) {
      await this.fetchOnce();
      if (signal.aborted) return;
      if (this.bundle) {
        await this.wakeable.sleep(poll, signal);
      } else {
        await this.wakeable.sleep(retry, signal);
        retry = Math.min(retry * 2, poll);
      }
    }
  }
}
