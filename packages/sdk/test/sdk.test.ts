/**
 * The SDK's real logic, which is three things:
 *
 *   1. The SSE parser, because network chunks split wherever they like and a
 *      parser that assumes whole frames works perfectly on localhost.
 *   2. The retry policy, because retrying a POST that creates a migration is how
 *      a customer gets two migrations.
 *   3. Error mapping, because a 402 that reads as a generic failure gets retried
 *      in a loop by somebody's CI.
 *
 * Everything else in the package is a URL and a JSON.parse.
 */

import { describe, expect, test } from "bun:test";

import { parseFrame, readFrames } from "../src/sse.ts";
import { errorFor, InsufficientCreditsError, MissingScopeError, AuthenticationError, NotFoundError, RelayError } from "../src/errors.ts";
import { HttpClient } from "../src/client.ts";
import { Runs } from "../src/runs.ts";
import type { RunEvent } from "../src/types.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

/** A ReadableStream that emits exactly the chunks given, as bytes. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const out = [];
  for await (const frame of readFrames(streamOf(chunks))) out.push(frame);
  return out;
}

// ── frame parsing ────────────────────────────────────────────────────────────

describe("parseFrame", () => {
  test("reads event and data", () => {
    expect(parseFrame("event: run\ndata: {\"a\":1}")).toEqual({ event: "run", data: '{"a":1}' });
  });

  test("defaults to the message event", () => {
    expect(parseFrame("data: hello")?.event).toBe("message");
  });

  test("joins multiple data lines with a newline, per the spec", () => {
    expect(parseFrame("event: x\ndata: one\ndata: two")?.data).toBe("one\ntwo");
  });

  test("strips exactly one leading space", () => {
    // Two spaces means the second belongs to the data.
    expect(parseFrame("data:  padded")?.data).toBe(" padded");
    expect(parseFrame("data:tight")?.data).toBe("tight");
  });

  test("ignores comment frames", () => {
    // The server sends ": keepalive" every few seconds. Surfacing those as
    // events would wake every consumer for nothing.
    expect(parseFrame(": keepalive")).toBeUndefined();
    expect(parseFrame("")).toBeUndefined();
  });

  test("ignores unknown fields rather than failing", () => {
    // So the server can add a field without breaking deployed clients.
    expect(parseFrame("event: run\nfuture: 1\ndata: ok")?.data).toBe("ok");
  });

  test("reads id and retry", () => {
    const frame = parseFrame("id: 7\nretry: 3000\ndata: x");
    expect(frame?.id).toBe("7");
    expect(frame?.retry).toBe(3000);
  });
});

// ── stream framing ───────────────────────────────────────────────────────────

describe("readFrames", () => {
  test("reads whole frames", async () => {
    const frames = await collect(["event: run\ndata: 1\n\nevent: done\ndata: 2\n\n"]);
    expect(frames.map((f) => f.event)).toEqual(["run", "done"]);
  });

  test("reassembles a frame split across chunks", async () => {
    // The failure this guards: a chunk boundary lands mid-frame and a naive
    // parser emits two broken halves, or drops both.
    const frames = await collect(["event: run\nda", "ta: {\"x\":", "1}\n\n"]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe('{"x":1}');
  });

  test("reassembles a frame split inside the blank-line boundary", async () => {
    const frames = await collect(["event: run\ndata: 1\n", "\nevent: done\ndata: 2\n\n"]);
    expect(frames.map((f) => f.event)).toEqual(["run", "done"]);
  });

  test("survives a chunk boundary inside a multi-byte character", async () => {
    // TextDecoder without { stream: true } emits U+FFFD for the half that
    // arrived, corrupting the JSON silently.
    const encoder = new TextEncoder();
    const full = encoder.encode('event: run\ndata: {"org":"Ünïcodé →"}\n\n');
    const cut = 22; // lands inside a multi-byte sequence
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(full.slice(0, cut));
        controller.enqueue(full.slice(cut));
        controller.close();
      },
    });
    const out = [];
    for await (const frame of readFrames(stream)) out.push(frame);
    expect(JSON.parse(out[0]!.data).org).toBe("Ünïcodé →");
  });

  test("handles CRLF, which a proxy may rewrite into", async () => {
    const frames = await collect(["event: run\r\ndata: 1\r\n\r\n"]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe("1");
  });

  test("drops keepalives without yielding", async () => {
    const frames = await collect([": keepalive\n\n", "event: run\ndata: 1\n\n", ": keepalive\n\n"]);
    expect(frames).toHaveLength(1);
  });

  test("emits a trailing frame the server never terminated", async () => {
    // Better than silently dropping the last event of a run.
    const frames = await collect(["event: done\ndata: {\"status\":\"completed\"}"]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe("done");
  });
});

// ── errors ───────────────────────────────────────────────────────────────────

describe("error mapping", () => {
  test("402 becomes a typed insufficient-credits error", () => {
    const err = errorFor(402, { error: "no credits", balance: 0, code: "insufficient_credits" });
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect((err as InsufficientCreditsError).balance).toBe(0);
  });

  test("403 with a scope names the scope", () => {
    const err = errorFor(403, { error: "nope", scope: "runs:approve" });
    expect(err).toBeInstanceOf(MissingScopeError);
    expect((err as MissingScopeError).scope).toBe("runs:approve");
  });

  test("403 without a scope stays generic", () => {
    // The session-only endpoints return 403 with no scope field.
    expect(errorFor(403, { error: "keys come from the console" })).not.toBeInstanceOf(
      MissingScopeError,
    );
  });

  test("401 and 404 are their own types", () => {
    expect(errorFor(401, {})).toBeInstanceOf(AuthenticationError);
    expect(errorFor(404, {})).toBeInstanceOf(NotFoundError);
  });

  test("carries the server's message through", () => {
    expect(errorFor(400, { error: "system is required" }).message).toBe("system is required");
  });
});

// ── retry policy ─────────────────────────────────────────────────────────────

function fakeFetch(responses: Array<() => Response | Promise<Response>>) {
  let i = 0;
  const calls: Array<{ url: string; method: string }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("retry policy", () => {
  test("a GET retries through a 5xx and succeeds", async () => {
    const { fn, calls } = fakeFetch([
      () => json({ error: "boom" }, 503),
      () => json({ runs: [] }),
    ]);
    const client = new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://t", fetch: fn, maxRetries: 2 });
    await expect(client.get("/api/runs")).resolves.toEqual({ runs: [] } as never);
    expect(calls).toHaveLength(2);
  });

  test("a POST is never retried", async () => {
    // THE test in this file. There is no idempotency key for run creation, so a
    // replayed POST is a second migration against a customer's real org.
    const { fn, calls } = fakeFetch([() => json({ error: "boom" }, 503)]);
    const client = new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://t", fetch: fn, maxRetries: 5 });
    await expect(client.post("/api/runs", {})).rejects.toBeInstanceOf(RelayError);
    expect(calls).toHaveLength(1);
  });

  test("a 4xx is never retried, on any method", async () => {
    const { fn, calls } = fakeFetch([() => json({ error: "no credits", balance: 0 }, 402)]);
    const client = new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://t", fetch: fn, maxRetries: 5 });
    await expect(client.get("/api/runs")).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(calls).toHaveLength(1);
  });

  test("sends the bearer token", async () => {
    let auth: string | undefined;
    const fn = (async (_url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization") ?? undefined;
      return json({ runs: [] });
    }) as unknown as typeof globalThis.fetch;
    await new HttpClient({ apiKey: "relay_sk_abc", baseUrl: "http://t", fetch: fn }).get("/api/runs");
    expect(auth).toBe("Bearer relay_sk_abc");
  });

  test("refuses to construct without a base URL", () => {
    // THE reason there is no default host. This client attaches
    // `Authorization: Bearer relay_sk_…` to every request, so a hardcoded
    // fallback would hand a live key to whoever owns that domain the first time
    // somebody forgot to configure it. Failing loudly costs an error message.
    const saved = process.env["RELAY_BASE_URL"];
    delete process.env["RELAY_BASE_URL"];
    try {
      expect(() => new HttpClient({ apiKey: "relay_sk_x", fetch: fetch })).toThrow(
        /No base URL/,
      );
    } finally {
      if (saved !== undefined) process.env["RELAY_BASE_URL"] = saved;
    }
  });

  test("takes the base URL from the environment when not passed", () => {
    const saved = process.env["RELAY_BASE_URL"];
    process.env["RELAY_BASE_URL"] = "https://app.example.com/";
    try {
      const client = new HttpClient({ apiKey: "relay_sk_x", fetch: fetch });
      // Trailing slash trimmed, so paths don't end up doubled.
      expect(client.url("/api/runs")).toBe("https://app.example.com/api/runs");
    } finally {
      if (saved === undefined) delete process.env["RELAY_BASE_URL"];
      else process.env["RELAY_BASE_URL"] = saved;
    }
  });

  test("refuses to construct without a key", () => {
    expect(() => new HttpClient({ apiKey: "", baseUrl: "http://t", fetch: fetch })).toThrow(
      /No API key/,
    );
  });

  test("an HTML error page does not surface as a JSON parse error", () => {
    // A proxy returning its own 502 page used to produce "unexpected token <".
    const err = errorFor(502, { error: "<html>Bad Gateway</html>" });
    expect(err.message).toContain("Bad Gateway");
  });
});

// ── what the control verbs actually put on the wire ──────────────────────────

/** Records every JSON body the client sends. */
function recordingFetch() {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return json({});
  }) as unknown as typeof globalThis.fetch;
  return { fn, sent };
}

describe("control verbs on the wire", () => {
  /** The route's allowlist. Mirrored here so a drift breaks a test, not a user. */
  const ACCEPTED = new Set(["pause", "resume", "stop", "answer", "message"]);

  test("every control verb sends an action the server accepts", async () => {
    // Two published methods shipped broken because nothing checked this:
    // stop() sent "abort" (the internal control-plane signal) and takeover()
    // sent "takeover" (the human name for the feature). Both 400'd on every
    // call. Mocked fetch means any string "works", so the assertion has to be
    // against the server's vocabulary, not against the call succeeding.
    const { fn, sent } = recordingFetch();
    const runs = new Runs(
      new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://t", fetch: fn }),
    );

    await runs.pause("r1");
    await runs.resume("r1");
    await runs.stop("r1");
    await runs.answer("r1", "yes");
    await runs.approve("r1");
    await runs.message("r1", "skip Deal_Registration__c");

    const actions = sent.map((s) => s.body.action);
    expect(actions).toHaveLength(6);
    expect(actions.filter((a) => !ACCEPTED.has(String(a)))).toEqual([]);
  });

  test("reject() sends a bare verdict the gate can parse", async () => {
    // parseVerdict is fully anchored, so "reject <note>" matched neither
    // APPROVE nor REJECT and fell through to changes-requested — which maps
    // back to awaiting-approval. The run became permanently unrejectable while
    // the CLI printed "Rejected".
    const { fn, sent } = recordingFetch();
    const runs = new Runs(
      new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://t", fetch: fn }),
    );

    await runs.reject("r1", "we are not ready");

    const answer = sent.find((s) => s.body.action === "answer");
    expect(answer?.body.text).toBe("reject");
    // The note still reaches the operator, as its own message.
    expect(sent.find((s) => s.body.action === "message")?.body.text).toBe("we are not ready");
  });

  test("takeover sends the action the browser route validates", async () => {
    const { fn, sent } = recordingFetch();
    const runs = new Runs(
      new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://t", fetch: fn }),
    );

    await runs.takeover("r1", true);
    await runs.takeover("r1", false);

    expect(sent.map((s) => s.body.action)).toEqual(["take", "release"]);
  });
});

// ── watch ────────────────────────────────────────────────────────────────────

function sseResponse(body: string): Response {
  return new Response(streamOf([body]), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("watch", () => {
  test("yields run events and stops at done", async () => {
    const fn = (async () =>
      sseResponse(
        'event: run\ndata: {"record":{"runId":"r1"},"view":{},"browsers":[]}\n\n' +
          'event: done\ndata: {"status":"completed"}\n\n',
      )) as unknown as typeof globalThis.fetch;

    const runs = new Runs(new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://t", fetch: fn }));
    const seen: RunEvent[] = [];
    for await (const event of runs.watch("r1")) seen.push(event);

    expect(seen.map((e) => e.type)).toEqual(["run", "done"]);
  });

  test("reconnects when the server closes a stream that has not finished", async () => {
    // The server caps a stream at fifteen minutes and closes it cleanly. That is
    // not the run ending, and a client that stopped there would go silent
    // halfway through a long migration.
    let call = 0;
    const fn = (async () => {
      call++;
      return call === 1
        ? sseResponse('event: run\ndata: {"record":{"runId":"r1"},"view":{},"browsers":[]}\n\n')
        : sseResponse('event: done\ndata: {"status":"completed"}\n\n');
    }) as unknown as typeof globalThis.fetch;

    const runs = new Runs(new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://t", fetch: fn }));
    const seen: RunEvent[] = [];
    for await (const event of runs.watch("r1")) seen.push(event);

    expect(call).toBe(2);
    expect(seen.map((e) => e.type)).toEqual(["run", "done"]);
  });

  test("a 404 ends the watch instead of reconnecting forever", async () => {
    const fn = (async () => json({ error: "No such run." }, 404)) as unknown as typeof globalThis.fetch;
    const runs = new Runs(new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://t", fetch: fn }));
    const iterate = async () => {
      for await (const _ of runs.watch("nope")) void _;
    };
    await expect(iterate()).rejects.toBeInstanceOf(NotFoundError);
  });

  test("an abort signal ends the watch quietly", async () => {
    const controller = new AbortController();
    const fn = (async () =>
      sseResponse('event: run\ndata: {"record":{"runId":"r1"},"view":{},"browsers":[]}\n\n')) as unknown as typeof globalThis.fetch;

    const runs = new Runs(new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://t", fetch: fn }));
    const seen: RunEvent[] = [];
    for await (const event of runs.watch("r1", { signal: controller.signal })) {
      seen.push(event);
      controller.abort();
    }
    // Returns rather than throwing — an abort is the caller's own decision.
    expect(seen).toHaveLength(1);
  });

  test("a reconnect resumes from the last id it saw", async () => {
    // Without this the server re-reads and re-verifies the entire trajectory on
    // every reconnect — and an SDK client reconnects forever where a browser
    // tab would have been closed.
    const seenHeaders: Array<string | null> = [];
    let call = 0;
    const fn = (async (_u: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push(new Headers(init?.headers).get("last-event-id"));
      call++;
      return call === 1
        ? sseResponse('id: 42\nevent: run\ndata: {"record":{"runId":"r1"},"view":{},"browsers":[]}\n\n')
        : sseResponse('id: 43\nevent: done\ndata: {"status":"completed"}\n\n');
    }) as unknown as typeof globalThis.fetch;

    const runs = new Runs(new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://t", fetch: fn }));
    for await (const _ of runs.watch("r1")) void _;

    // First connect has nothing to resume from; the second carries the id.
    expect(seenHeaders).toEqual([null, "42"]);
  });

  test("an unparseable frame is skipped, not thrown on", async () => {
    const fn = (async () =>
      sseResponse(
        "event: run\ndata: {not json\n\n" +
          'event: done\ndata: {"status":"completed"}\n\n',
      )) as unknown as typeof globalThis.fetch;

    const runs = new Runs(new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://t", fetch: fn }));
    const seen: RunEvent[] = [];
    for await (const event of runs.watch("r1")) seen.push(event);
    expect(seen.map((e) => e.type)).toEqual(["done"]);
  });
});
