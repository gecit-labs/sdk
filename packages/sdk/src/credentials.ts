/**
 * The logins a scout signs in with.
 *
 * ── Nothing here can read a secret back ─────────────────────────────────────
 *
 * `list()` returns names, systems and timestamps. There is no `get()`, because
 * the server has no endpoint that unseals — an operator managing their logins
 * has no reason to be shown one, and a value that can be fetched is a value that
 * ends up in a log, a screenshot and a support ticket.
 *
 * ── What `put()` costs you ──────────────────────────────────────────────────
 *
 * The plaintext travels to the server, because the sealing key lives there and
 * always will: a client that could seal could also unseal, and then the key is
 * on every laptop that ever installed this package. That is how every password
 * manager works. It does mean this call deserves the same care as typing the
 * password into the vendor's own login page — over TLS, from somewhere you
 * trust, and never logged by your own code on the way in.
 *
 * `put()` and `remove()` need the `credentials:write` scope, which is not
 * granted by default. `list()` needs only `runs:read` — it returns names, not
 * secrets. Saying the whole module needed the write scope pushed readers toward
 * granting the one scope this SDK deliberately withholds just to read a list.
 */

import type { HttpClient } from "./client.ts";
import type { CredentialSummary, PutCredentialInput } from "./types.ts";

export class Credentials {
  constructor(private readonly http: HttpClient) {}

  /** Stored logins, as summaries. Never includes a secret. */
  async list(): Promise<CredentialSummary[]> {
    const { credentials } = await this.http.get<{ credentials: CredentialSummary[] }>(
      "/api/credentials",
    );
    return credentials;
  }

  /**
   * Store a login under a broker path, e.g. `sf/readonly` — the same string the
   * agent asks for. Replaces whatever was there.
   */
  async put(path: string, input: PutCredentialInput): Promise<void> {
    await this.http.put(`/api/credentials/${encodePath(path)}`, input);
  }

  /** Forget a login. */
  async remove(path: string): Promise<void> {
    await this.http.delete(`/api/credentials/${encodePath(path)}`);
  }
}

/**
 * Encode each segment but keep the slashes.
 *
 * `encodeURIComponent("sf/readonly")` would turn the separator into %2F, which
 * the catch-all route then receives as a single segment and stores under a name
 * nobody asked for. Encoding per-segment keeps the path structure and still
 * escapes anything odd inside a segment.
 */
function encodePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
}
