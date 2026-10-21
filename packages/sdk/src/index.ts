/**
 * Relay — the migration substrate, as a client.
 *
 *     import { Relay, approvalCard } from "@userelay/sdk";
 *
 *     const relay = new Relay({ apiKey: process.env.RELAY_API_KEY });
 *
 *     const run = await relay.runs.create({
 *       mode: "live",
 *       source: { system: "salesforce", orgLabel: "Acme prod",
 *                 entryUrl: "https://acme.my.salesforce.com", credentialPath: "sf/readonly" },
 *       dest:   { system: "attio", orgLabel: "Acme Attio" },
 *     });
 *
 *     for await (const event of relay.runs.watch(run.runId)) {
 *       if (event.type !== "run") continue;
 *       if (event.liveViewUrl) notifyOnCall(event.liveViewUrl);
 *       const card = approvalCard(event);
 *       if (card) console.log("cutover estimate:", card.estimate);
 *     }
 *
 * ── Zero runtime dependencies ───────────────────────────────────────────────
 *
 * Not asceticism. An SDK's install footprint is the first thing a platform team
 * looks at, and everything this package would otherwise pull in would be
 * guarding against a server we control.
 *
 * ── What this client cannot do, on purpose ──────────────────────────────────
 *
 *   · **Mint or revoke keys.** Those need a session. If a key could mint a key,
 *     a leaked read-only token escalates itself to one that can approve a
 *     cutover, and the scope system stops meaning anything. Keys come from the
 *     console.
 *   · **Add credits.** A workspace granting itself money is a free-money
 *     endpoint whose only protection is that nobody noticed it.
 *   · **Drive a browser during takeover.** `runs.takeover()` hands you a URL for
 *     a person to open. Clearing an MFA prompt is the human's job, and a client
 *     that pretended otherwise would fail in the least recoverable place.
 */

import { HttpClient, type RelayOptions } from "./client.ts";
import { Runs } from "./runs.ts";
import { Credits } from "./credits.ts";
import { Credentials } from "./credentials.ts";

export class Relay {
  readonly runs: Runs;
  readonly credits: Credits;
  readonly credentials: Credentials;

  constructor(options: RelayOptions = {}) {
    const http = new HttpClient(options);
    this.runs = new Runs(http);
    this.credits = new Credits(http);
    this.credentials = new Credentials(http);
  }
}

export { Runs, Credits, Credentials };
export type { RelayOptions } from "./client.ts";
export type { WatchOptions } from "./runs.ts";

export {
  AuthenticationError,
  InsufficientCreditsError,
  MissingScopeError,
  NotFoundError,
  RelayError,
} from "./errors.ts";

export { approvalCard, needsAHuman } from "./card.ts";
export { parseFrame, readFrames } from "./sse.ts";
export type { SseFrame } from "./sse.ts";

export type * from "./types.ts";
