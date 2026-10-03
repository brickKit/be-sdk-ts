// /readyz (P1.4): ready once every condition was met; a condition once met stays met, so a later outage of a
// dependency never takes every replica out of service.
export class Readiness {
  private readonly waiting: Set<string>;
  private latched = false;

  constructor(conditions: string[]) {
    this.waiting = new Set(conditions);
    this.latched = this.waiting.size === 0;
  }

  require(condition: string): void {
    if (!this.latched) this.waiting.add(condition);
  }

  met(condition: string): void {
    this.waiting.delete(condition);
    if (this.waiting.size === 0) this.latched = true;
  }

  /** Ignored once latched (fail-static). */
  unmet(condition: string): void {
    if (!this.latched) this.waiting.add(condition);
  }

  state(): { ok: boolean; waiting: string[] } {
    return this.latched ? { ok: true, waiting: [] } : { ok: false, waiting: [...this.waiting] };
  }
}
