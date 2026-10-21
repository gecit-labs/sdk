/**
 * The plan a human is being asked to approve.
 *
 * The card does not sit at the top of the run view, and it would be misleading
 * if it did: it exists only while a decision is actually open, and it belongs to
 * the *question*, not to the run. The server puts it on
 * `view.pendingQuestion.context.card`, which is exactly right and exactly the
 * sort of path an SDK should not make its users memorise.
 *
 *     const card = approvalCard(await relay.runs.get(id));
 *     if (card) console.log(card.estimate?.credits, "credits");
 *
 * Returns undefined when the run is not at the gate — which is most of the time,
 * and is not an error.
 */

import type { ApprovalCard, RunDetail } from "./types.ts";

export function approvalCard(run: Pick<RunDetail, "view">): ApprovalCard | undefined {
  return run.view?.pendingQuestion?.context?.card;
}

/** True when a person, not a script, is what this run is waiting for. */
export function needsAHuman(run: Pick<RunDetail, "record">): boolean {
  return run.record.status === "awaiting-approval" || run.record.status === "awaiting-input";
}
