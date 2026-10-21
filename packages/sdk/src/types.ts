/**
 * The wire shapes.
 *
 * Hand-written rather than generated, and deliberately not validated at runtime:
 * the server is ours, and shipping a schema validator would double the install
 * size to guard against a response we control. Fields the client does not model
 * are preserved by the index signatures rather than stripped, so a server that
 * adds one does not require an SDK release before anyone can see it.
 */

export type RunMode = "fixture" | "live";

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "awaiting-approval"
  | "awaiting-input"
  | "completed"
  | "failed"
  | "rejected"
  | "aborted";

export interface ScoutTarget {
  system: string;
  orgLabel: string;
  entryUrl?: string;
  credentialPath?: string;
}

export interface RunRecord {
  runId: string;
  tenantId: string;
  label: string;
  status: RunStatus;
  mode: RunMode;
  sourceSystem?: string;
  destSystem?: string;
  sourceTarget?: ScoutTarget;
  destTarget?: ScoutTarget;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
  [key: string]: unknown;
}

/** What the cutover is forecast to cost. Absent until the plan exists. */
export interface RunEstimate {
  credits: number;
  records: number;
  rateVersion: string;
  /** True when the source surfaced no record counts — unknown, not free. */
  unknown: boolean;
  lines: Array<{ unit: string; quantity: number; credits: number; assumption: string }>;
}

export interface ApprovalCard {
  title: string;
  summary: string;
  objectsMapped: number;
  objectsUnmapped: number;
  fieldsUnmapped: number;
  unmappedFields: string[];
  liveRecordCount: number;
  rehearsedRecords: number;
  estimate?: RunEstimate;
  /** Credits already metered against this run. Fact, not forecast. */
  spent?: number;
  [key: string]: unknown;
}

export interface PendingQuestion {
  id: string;
  kind: string;
  question: string;
  options?: string[];
  /**
   * Structured detail behind the question. For the approval gate this holds
   * `{ card }` — the whole plan, including the cutover estimate.
   *
   * Reach for `approvalCard(detail)` rather than digging in here; it exists so
   * callers do not depend on this shape.
   */
  context?: { card?: ApprovalCard } & Record<string, unknown>;
  [key: string]: unknown;
}

/** The projected run — stages, activity, and whatever it is waiting on. */
export interface RunView {
  status: string;
  headline: string;
  stages: Array<{ id: string; status: string; detail?: string }>;
  /**
   * What the run is waiting on, if anything. At the approval gate its `context`
   * carries the plan — see `approvalCard()`.
   */
  pendingQuestion?: PendingQuestion;
  [key: string]: unknown;
}

export interface BrowserSession {
  sessionId: string;
  system: string;
  status: "live" | "frozen" | "released" | "failed";
  lastUrl?: string;
  takeoverBy?: string;
  [key: string]: unknown;
}

/** One run, in full. The same shape `watch()` yields on a `run` event. */
export interface RunDetail {
  record: RunRecord;
  view: RunView;
  browsers: BrowserSession[];
  /** Present only while a browser is live. Short-lived — do not cache it. */
  liveViewUrl?: string;
}

export interface CreateRunInput {
  mode?: RunMode;
  source: ScoutTarget;
  dest: ScoutTarget;
  label?: string;
  seed?: number;
  recordsPerObject?: number;
  /**
   * Ask for a run that writes for real, rather than rehearsing.
   *
   * This is intent, not authority. It does not approve anything: the
   * orchestrator will not reach the execute stage without an `approve` verdict
   * in the trajectory, and approving needs the `runs:approve` scope, which a
   * default key does not carry. So a leaked key can ask for a live run and
   * still not authorise one.
   *
   * What it does change: whether the run is credit-gated at creation, and
   * whether the destination writer is real or in-memory. A run created without
   * it can only ever rehearse.
   */
  execute?: boolean;
}

export interface LedgerEntry {
  entryId: string;
  delta: number;
  reason: string;
  runId?: string;
  createdAt: string;
}

export interface Balance {
  /** False on a deployment that meters nothing; `balance` is then null. */
  metered: boolean;
  balance: number | null;
  balanceLabel?: string;
  entries: LedgerEntry[];
}

export interface UsageRow {
  runId: string;
  stage: string;
  unit: string;
  quantity: number;
  credits: number;
  rateVersion: string;
  recordedAt: string;
}

export interface Usage {
  metered: boolean;
  rows: UsageRow[];
  totalCredits: number;
  totalLabel?: string;
  truncated?: boolean;
}

export interface CredentialSummary {
  path: string;
  system: string;
  username?: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  /** Sealed under a key that has since rotated — unreadable, re-enter it. */
  orphaned?: boolean;
}

export interface PutCredentialInput {
  system: string;
  password?: string;
  token?: string;
  username?: string;
  label?: string;
}

// ── stream events ────────────────────────────────────────────────────────────

/** The run changed. Carries the whole state, not a delta. */
export interface RunChangedEvent extends RunDetail {
  type: "run";
}

/** The run reached a terminal status and will not change again. */
export interface RunDoneEvent {
  type: "done";
  status: RunStatus;
}

/** The run disappeared — deleted, or never yours. */
export interface RunGoneEvent {
  type: "gone";
  runId: string;
}

/** The server hit an error mid-stream. The stream ends after this. */
export interface RunStreamErrorEvent {
  type: "error";
  message: string;
}

export type RunEvent = RunChangedEvent | RunDoneEvent | RunGoneEvent | RunStreamErrorEvent;
