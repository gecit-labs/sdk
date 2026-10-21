/**
 * Server-sent events, read off a `fetch` response.
 *
 * This is the one part of the SDK that is not a thin wrapper, and it exists for
 * a specific reason: **`EventSource` cannot set an `Authorization` header.** The
 * browser API has no way to attach one, and the server's stream is behind an API
 * key, so the standard client is unusable here. What is left is `fetch` plus
 * `response.body.getReader()` plus a frame parser, which is this file.
 *
 * ── Frames, not lines ───────────────────────────────────────────────────────
 *
 * An SSE frame ends at a blank line, and a chunk from the network boundary can
 * split anywhere — mid-frame, mid-line, mid-UTF-8-character. So bytes are
 * decoded with `stream: true` (which holds a partial multi-byte character back
 * rather than emitting a replacement char) and accumulated in a buffer that is
 * only cut on a blank line. Parsing chunk-by-chunk instead is the bug that shows
 * up as "works locally, drops events in production", because locally every frame
 * arrives whole.
 *
 * ── What is deliberately handled ────────────────────────────────────────────
 *
 *   · `\r\n` and `\n` line endings, since a proxy may rewrite them
 *   · multiple `data:` lines in one frame, joined with a newline per the spec
 *   · `:` comment frames — the server sends these as keepalives, and they must
 *     not surface as events
 *   · a leading space after the colon, which the spec says to strip exactly once
 */

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
  /** Server-suggested reconnect delay, from a `retry:` line. */
  retry?: number;
}

/** Split one raw frame into its fields. Undefined for a comment or empty frame. */
export function parseFrame(raw: string): SseFrame | undefined {
  const lines = raw.split(/\r\n|\r|\n/);
  const data: string[] = [];
  let event = "message";
  let id: string | undefined;
  let retry: number | undefined;

  for (const line of lines) {
    // A line starting with ":" is a comment. The server sends ": keepalive".
    if (line.length === 0 || line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // Exactly one leading space is stripped, per the spec. Two spaces means the
    // second one is data.
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        id = value;
        break;
      case "retry": {
        const ms = Number(value);
        if (Number.isFinite(ms) && ms >= 0) retry = ms;
        break;
      }
      default:
        // Unknown fields are ignored rather than treated as an error, so the
        // server can add one without breaking every deployed client.
        break;
    }
  }

  if (data.length === 0 && id === undefined && retry === undefined) return undefined;
  return { event, data: data.join("\n"), ...(id !== undefined ? { id } : {}), ...(retry !== undefined ? { retry } : {}) };
}

/**
 * Turn a byte stream into SSE frames.
 *
 * Yields nothing for keepalives. Ends when the stream ends; reconnection is the
 * caller's decision, because only the caller knows whether the thing it was
 * watching has finished.
 */
export async function* readFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // stream: true holds back a partial multi-byte character instead of
      // emitting U+FFFD for the half that arrived.
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const boundary = findBoundary(buffer);
        if (boundary === undefined) break;
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }

    // Whatever is left when the stream closes cleanly is a frame the server did
    // not terminate. Emitting it beats dropping the last event of a run.
    const tail = parseFrame(buffer + decoder.decode());
    if (tail) yield tail;
  } finally {
    // Cancel rather than just dropping the reader: an abandoned reader leaves
    // the socket open until GC, and a long-lived process watching many runs
    // would accumulate them.
    await reader.cancel().catch(() => {});
  }
}

/** The first blank-line boundary, handling both `\n\n` and `\r\n\r\n`. */
function findBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}
