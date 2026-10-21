/**
 * The transport: one place that knows about the token, the base URL, and what a
 * failure means.
 *
 * ── Retries are for the network, not for the answer ─────────────────────────
 *
 * A GET is retried on a connection error or a 5xx, because those mean "the
 * request did not produce an answer". Nothing else is: a 402 is not going to
 * become a 200, a 403 is not going to grow a scope, and a POST that creates a
 * run must never be replayed on a timeout — the server has no idempotency key
 * for run creation, so a retry there is how a customer gets two migrations.
 *
 * That asymmetry is deliberate and is the only retry policy this client has.
 * Anything cleverer belongs in the caller, which knows whether its own operation
 * is safe to repeat.
 */

import { errorFor, RelayError } from "./errors.ts";

export interface RelayOptions {
  /** `relay_sk_…`. Defaults to `process.env.RELAY_API_KEY`. */
  apiKey?: string;
  /**
   * Where your deployment lives. Falls back to `process.env.RELAY_BASE_URL`.
   *
   * There is deliberately no built-in default. A hardcoded fallback host is a
   * credential leak waiting for one misconfiguration: this client sends
   * `Authorization: Bearer relay_sk_…` on every request, so a default pointing
   * at a domain we do not control would hand a live key to whoever owns it the
   * first time someone forgets to set this. Failing loudly costs one error
   * message; failing quietly costs the key.
   */
  baseUrl?: string;
  /** Per-request timeout in ms. Default 30s. Streams are exempt. */
  timeoutMs?: number;
  /** How many times to retry a GET that never got an answer. Default 2. */
  maxRetries?: number;
  /** Swap in a custom fetch (tests, proxies, instrumentation). */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: RelayOptions = {}) {
    const apiKey = options.apiKey ?? readEnv("RELAY_API_KEY");
    if (!apiKey) {
      throw new Error(
        "No API key. Pass { apiKey } or set RELAY_API_KEY. " +
          "Create one in the console under Settings.",
      );
    }
    this.apiKey = apiKey;
    const baseUrl = options.baseUrl ?? readEnv("RELAY_BASE_URL");
    if (!baseUrl) {
      throw new Error(
        "No base URL. Pass { baseUrl } or set RELAY_BASE_URL to your deployment, " +
          "e.g. https://app.example.com. There is no default on purpose — see the " +
          "note on RelayOptions.baseUrl.",
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.doFetch = options.fetch ?? globalThis.fetch;

    if (typeof this.doFetch !== "function") {
      throw new Error(
        "No global fetch. This SDK needs Node 18 or newer, or a fetch passed in options.",
      );
    }
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  async get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
    const query = params
      ? Object.entries(params)
          .filter((entry): entry is [string, string] => entry[1] !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")
      : "";
    return this.send<T>("GET", path + (query ? `?${query}` : ""), undefined, true);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>("POST", path, body, false);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>("PUT", path, body, false);
  }

  async delete<T>(path: string): Promise<T> {
    return this.send<T>("DELETE", path, undefined, false);
  }

  /** The raw response, for the stream. No timeout, no retry, no body parse. */
  async stream(path: string, signal?: AbortSignal, lastEventId?: string): Promise<Response> {
    const init: RequestInit = {
      method: "GET",
      headers: this.headers({
        accept: "text/event-stream",
        // The standard SSE resume header. The server folds forward from here
        // instead of replaying the whole trajectory, which is the difference
        // between a reconnect costing O(new events) and O(the run so far).
        ...(lastEventId ? { "last-event-id": lastEventId } : {}),
      }),
    };
    if (signal) init.signal = signal;

    const response = await this.doFetch(this.url(path), init);
    if (!response.ok) throw errorFor(response.status, await safeJson(response));
    if (!response.body) throw new RelayError("The stream had no body.", response.status);
    return response;
  }

  private async send<T>(
    method: string,
    path: string,
    body: unknown,
    retryable: boolean,
  ): Promise<T> {
    const attempts = retryable ? this.maxRetries + 1 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      // A fresh controller per attempt: an aborted one stays aborted, so
      // reusing it would make every retry fail instantly.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const init: RequestInit = {
          method,
          headers: this.headers(
            body === undefined ? {} : { "content-type": "application/json" },
          ),
          signal: controller.signal,
        };
        if (body !== undefined) init.body = JSON.stringify(body);

        const response = await this.doFetch(this.url(path), init);

        if (response.ok) return (await safeJson(response)) as T;

        const parsed = await safeJson(response);
        const error = errorFor(response.status, parsed);

        // A 5xx is "no answer yet"; a 4xx is an answer we do not like.
        if (response.status >= 500 && attempt < attempts - 1) {
          lastError = error;
          await backoff(attempt);
          continue;
        }
        throw error;
      } catch (err) {
        if (err instanceof RelayError) throw err;
        lastError = err;
        if (attempt < attempts - 1) {
          await backoff(attempt);
          continue;
        }
        throw new RelayError(
          `Could not reach Relay: ${(err as Error).message}`,
          0,
          { code: "network" },
        );
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new RelayError("Request failed.", 0, { code: "network" });
  }
}

/** Exponential, jittered. Jitter matters when a fleet retries in lockstep. */
async function backoff(attempt: number): Promise<void> {
  const base = Math.min(1_000 * 2 ** attempt, 8_000);
  const wait = base / 2 + Math.random() * (base / 2);
  await new Promise((resolve) => setTimeout(resolve, wait));
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // An HTML error page from a proxy, most likely. Keep it — truncated — so the
    // message says something more useful than "unexpected token <".
    return { error: text.slice(0, 300) };
  }
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const value = env?.[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}
