/**
 * Credits and usage — read-only, by design.
 *
 * There is no `grant()` here and there will not be one. Money enters through an
 * operator-side path (`relay credits grant`, or a payment webhook later), both
 * of which call the same ledger method with the same idempotency key. A client
 * that could top up its own balance would be a free-money endpoint whose only
 * protection is that nobody had tried it.
 */

import type { HttpClient } from "./client.ts";
import type { Balance, Usage } from "./types.ts";

export class Credits {
  constructor(private readonly http: HttpClient) {}

  /**
   * Credits remaining, and where they came from.
   *
   * `metered: false` with a null balance means the deployment meters nothing —
   * distinct from a balance of zero, which means you are out. Branching on the
   * number alone would show "out of credits" on a self-hosted install that never
   * had any.
   */
  async balance(): Promise<Balance> {
    return this.http.get<Balance>("/api/credits");
  }

  /**
   * What has been consumed. Pass a `runId` to narrow to one run.
   *
   * Every row carries the rate version that priced it, so a price change never
   * silently restates what an older run cost.
   */
  async usage(runId?: string): Promise<Usage> {
    return this.http.get<Usage>("/api/usage", runId ? { runId } : undefined);
  }
}
