/**
 * Runs — everything you can do to a migration.
 *
 * ── watch() reconnects, because a migration outlives a socket ───────────────
 *
 * A live run is minutes of browser work with a human pause in the middle. Any
 * connection held that long will be dropped by something — a load balancer idle
 * timeout, a laptop lid, a deploy. So the stream reconnects rather than ending,
 * and stops only when the run itself reaches a terminal state or the caller
 * aborts.
 *
 * The server sends the whole run state on every `run` event rather than a delta,
 * which is what makes that safe: a reconnect cannot miss a transition it needed
 * to apply, because there is no accumulated state to miss. The most recent event
 * is always the complete truth.
 */

import { readFrames } from "./sse.ts";
import { NotFoundError, RelayError } from "./errors.ts";
import type { HttpClient } from "./client.ts";
import type {
  BrowserSession,
  CreateRunInput,
  RunDetail,
  RunEvent,
  RunRecord,
} from "./types.ts";

export interface WatchOptions {
  /** Stop watching. The generator returns; it does not throw. */
  signal?: AbortSignal;
  /** Give up after this many consecutive failed reconnects. Default 5. */
  maxReconnects?: number;
}

const DEFAULT_MAX_RECONNECTS = 5;

export class Runs {
  constructor(private readonly http: HttpClient) {}

  /**
   * Queue a migration. Returns as soon as it is queued, not when it finishes —
   * a run is minutes of work and no HTTP request should be held open for it.
   *
   * Never retried on a timeout. There is no idempotency key for run creation, so
   * a replayed request is a second migration.
   */
  async create(input: CreateRunInput): Promise<RunRecord> {
    const { run } = await this.http.post<{ run: RunRecord }>("/api/runs", input);
    return run;
  }

  /**
   * This workspace's runs — the ones needing attention first, then most
   * recently updated. (The server buckets by status before ordering by time, so
   * `runs[0]` is whatever is waiting on a human, not the newest run.)
   *
   * Capped server-side. `listPage()` exposes whether the cap was hit.
   */
  async list(): Promise<RunRecord[]> {
    return (await this.listPage()).runs;
  }

  /** The same list, plus whether the server truncated it. */
  async listPage(): Promise<{ runs: RunRecord[]; truncated: boolean }> {
    const body = await this.http.get<{ runs: RunRecord[]; truncated?: boolean }>("/api/runs");
    return { runs: body.runs, truncated: body.truncated === true };
  }

  /** One run in full: the row, the projected view, and its browsers. */
  async get(runId: string): Promise<RunDetail> {
    return this.http.get<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
  }

  /** Stop at the next checkpoint. Resumable. */
  async pause(runId: string): Promise<void> {
    await this.control(runId, { action: "pause" });
  }

  /** Clear a pause (or a rest) and put the run back in the queue. */
  async resume(runId: string): Promise<void> {
    await this.control(runId, { action: "resume" });
  }

  /**
   * Stop now. Anything written is rolled back.
   *
   * The wire action is "stop", not "abort". "abort" is the *control-plane
   * signal* the route raises internally once it accepts this request; naming
   * the HTTP action after the internal signal shipped a method that returned
   * 400 every time it was called.
   */
  async stop(runId: string): Promise<void> {
    await this.control(runId, { action: "stop" });
  }

  /** Answer whatever the run asked — a login wall, a field question, the gate. */
  async answer(runId: string, text: string, questionId?: string): Promise<void> {
    await this.control(runId, {
      action: "answer",
      text,
      ...(questionId ? { questionId } : {}),
    });
  }

  /**
   * Approve the plan. Needs the `runs:approve` scope, which is not granted by
   * default — see the note in the README about why.
   */
  async approve(runId: string): Promise<void> {
    await this.answer(runId, "approve");
  }

  /**
   * Reject the plan. Same scope as approving: it settles the same gate.
   *
   * The note is sent separately, and that is load-bearing. `parseVerdict` is
   * fully anchored (`/^\s*(?:reject(?:ed)?|no|deny|...)\s*$/i`), so
   * "reject we are not ready" matched neither APPROVE nor REJECT and fell
   * through to `changes-requested` — which the orchestrator maps back to
   * `awaiting-approval`. The run re-queued, re-reached the gate, found the same
   * stored answer, and rested again: permanently unrejectable, while the CLI
   * printed "Rejected". Only the no-note call ever worked.
   */
  async reject(runId: string, note?: string): Promise<void> {
    if (note) await this.message(runId, note);
    await this.answer(runId, "reject");
  }

  /** Say something to a working run — e.g. "skip Deal_Registration__c". */
  async message(runId: string, text: string): Promise<void> {
    await this.control(runId, { action: "message", text });
  }

  /** The browsers this run rented, and a live-view URL if one is up. */
  async browsers(
    runId: string,
  ): Promise<{ browsers: BrowserSession[]; activeSessionId?: string; liveViewUrl?: string }> {
    return this.http.get(`/api/runs/${encodeURIComponent(runId)}/browser`);
  }

  /**
   * Take the wheel, or give it back.
   *
   * This is the one capability the SDK cannot replace: `liveViewUrl` is a page a
   * *person* opens to clear an SSO prompt or an MFA challenge. The SDK's job is
   * to hand that URL to whoever is on call, not to pretend to drive.
   */
  async takeover(runId: string, take: boolean): Promise<{ liveViewUrl?: string }> {
    // "take", not "takeover" — the route validates the former. Same class of
    // slip as stop() above: the SDK was written against the route's prose
    // rather than its validation.
    return this.http.post(`/api/runs/${encodeURIComponent(runId)}/browser`, {
      action: take ? "take" : "release",
    });
  }

  /**
   * Follow a run until it finishes.
   *
   *   for await (const event of relay.runs.watch(id)) {
   *     if (event.type === "run" && event.view.pendingQuestion) { ... }
   *   }
   */
  async *watch(runId: string, options: WatchOptions = {}): AsyncGenerator<RunEvent, void, unknown> {
    const maxReconnects = options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
    const path = `/api/runs/${encodeURIComponent(runId)}/stream`;
    let reconnects = 0;
    // The last `id:` the server sent. Handed back on reconnect so it resumes
    // rather than replaying — the frames already carry it, the parser already
    // reads it, and without this the server re-reads and re-verifies the whole
    // run every time a connection drops.
    let lastEventId: string | undefined;

    while (!options.signal?.aborted) {
      let response: Response;
      try {
        response = await this.http.stream(path, options.signal, lastEventId);
        reconnects = 0;
      } catch (err) {
        // A run that is gone stays gone; reconnecting would loop forever on a
        // 404. Anything else might be transient.
        if (err instanceof NotFoundError) throw err;
        if (options.signal?.aborted) return;
        if (++reconnects > maxReconnects) throw err;
        await pause(reconnects, options.signal);
        continue;
      }

      try {
        for await (const frame of readFrames(response.body!)) {
          if (frame.id !== undefined) lastEventId = frame.id;
          const event = toEvent(frame.event, frame.data);
          if (!event) continue;
          yield event;
          if (event.type === "done" || event.type === "gone" || event.type === "error") {
            return;
          }
        }
      } catch (err) {
        if (options.signal?.aborted) return;
        if (++reconnects > maxReconnects) throw err;
      }

      if (options.signal?.aborted) return;

      // The server caps a stream at fifteen minutes and closes it cleanly. That
      // is not the run ending, so reconnect — but with a floor, not instantly.
      //
      // Instantly was a spin risk: a successful connect resets `reconnects` to
      // zero, so maxReconnects could never trip on a connect-close-connect
      // loop. A proxy that closes bodies, or any path where the stream ends
      // without a terminal event, turned watch() into a tight loop where every
      // iteration costs an auth plus a full run read against a ten-connection
      // pool. One second is invisible against a fifteen-minute cap and bounds
      // the pathological case.
      await pause(1, options.signal);
    }
  }

  private async control(runId: string, body: Record<string, unknown>): Promise<void> {
    await this.http.post(`/api/runs/${encodeURIComponent(runId)}/control`, body);
  }
}

function toEvent(name: string, data: string): RunEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    // A frame we cannot parse is dropped rather than thrown on. The next `run`
    // event carries the whole state anyway, so nothing is lost by skipping one.
    return undefined;
  }

  switch (name) {
    case "run":
      return { type: "run", ...(parsed as object) } as RunEvent;
    case "done":
      return { type: "done", ...(parsed as object) } as RunEvent;
    case "gone":
      return { type: "gone", ...(parsed as object) } as RunEvent;
    case "error":
      return { type: "error", ...(parsed as object) } as RunEvent;
    default:
      return undefined;
  }
}

async function pause(attempt: number, signal?: AbortSignal): Promise<void> {
  if (attempt === 0) return;
  const ms = Math.min(1_000 * 2 ** (attempt - 1), 15_000);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export { RelayError };
