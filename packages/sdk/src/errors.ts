/**
 * What can go wrong, as types you can branch on.
 *
 * The reason these are distinct classes rather than one error with a status code
 * is that two of them mean "do something different", not "try again":
 *
 *   InsufficientCredits  the workspace is out of money. Retrying is pointless
 *                        and a retry loop on a 402 is how a customer discovers
 *                        their CI has been spinning for six hours.
 *   MissingScope         the key is not allowed to do this. Also permanent, and
 *                        the fix is a person minting a different key — which the
 *                        error names, so nobody has to go and read the docs.
 *
 * Everything else is a RelayError with the status on it.
 */

export class RelayError extends Error {
  readonly status: number;
  readonly code?: string;
  /** The parsed body, when there was one. Useful for fields we don't model. */
  readonly body?: unknown;

  constructor(message: string, status: number, opts: { code?: string; body?: unknown } = {}) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.body !== undefined) this.body = opts.body;
  }
}

/** 402. The workspace has no credits. Never retry this. */
export class InsufficientCreditsError extends RelayError {
  readonly balance: number;

  constructor(message: string, balance: number, body?: unknown) {
    super(message, 402, { code: "insufficient_credits", body });
    this.name = "InsufficientCreditsError";
    this.balance = balance;
  }
}

/** 403 with a named scope. The key needs re-minting; retrying will not help. */
export class MissingScopeError extends RelayError {
  readonly scope: string;

  constructor(message: string, scope: string, body?: unknown) {
    super(message, 403, { code: "missing_scope", body });
    this.name = "MissingScopeError";
    this.scope = scope;
  }
}

/** 401. The token is absent, malformed, revoked or expired — all read alike. */
export class AuthenticationError extends RelayError {
  constructor(message: string, body?: unknown) {
    super(message, 401, { code: "unauthenticated", body });
    this.name = "AuthenticationError";
  }
}

/** 404, and deliberately also "not yours" — the API does not distinguish. */
export class NotFoundError extends RelayError {
  constructor(message: string, body?: unknown) {
    super(message, 404, { code: "not_found", body });
    this.name = "NotFoundError";
  }
}

/** Build the right error for a failed response. */
export function errorFor(status: number, body: unknown): RelayError {
  const record = (body ?? {}) as Record<string, unknown>;
  const message =
    typeof record.error === "string" ? record.error : `Relay returned ${status}.`;

  if (status === 402) {
    const balance = typeof record.balance === "number" ? record.balance : 0;
    return new InsufficientCreditsError(message, balance, body);
  }
  if (status === 403 && typeof record.scope === "string") {
    return new MissingScopeError(message, record.scope, body);
  }
  if (status === 401) return new AuthenticationError(message, body);
  if (status === 404) return new NotFoundError(message, body);

  return new RelayError(message, status, {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    body,
  });
}
