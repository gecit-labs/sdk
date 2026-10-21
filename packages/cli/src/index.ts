#!/usr/bin/env node
/**
 * relay — the CLI, over the API.
 *
 * ── Every verb here goes through @userelay/sdk ─────────────────────────────────
 *
 * There is no database client in this package and there must never be one. The
 * repo already learned this lesson one level down, in the control plane:
 *
 *   > This is the same set of verbs, over HTTP, against the same RunControl --
 *   > not a parallel implementation, which matters because the orchestrator only
 *   > honours what it finds in the control plane.
 *
 * The same reasoning applies here with higher stakes. If this CLI kept a private
 * door to Postgres, we would drive the database path and customers would drive
 * the HTTP path, and the HTTP path is the one that rots -- because it is the one
 * nobody on this team uses daily. Going through the SDK means every command a
 * person runs is the same code a customer's script runs.
 *
 * Local, fixture and operational work (scout, plan, simulate, worker, db, audit,
 * creds-in-the-vault) lives in the core's own dev binary, which is a different
 * tool for a different audience.
 */

import { createRequire } from "node:module";

import { Command } from "commander";
import {
  approvalCard,
  InsufficientCreditsError,
  MissingScopeError,
  Relay,
  RelayError,
  type RunEvent,
} from "@userelay/sdk";
import { apiKey, baseUrl, forgetKey, saveKey } from "./config.ts";
import { bold, cyan, dim, fail, green, money, status, table, when, yellow } from "./render.ts";

/**
 * The host shown in help text when someone has not configured one.
 *
 * An example only — it is never used as a fallback, because a fallback would
 * receive a live API key the first time somebody misconfigured this. It exists
 * so the error message is copy-pasteable rather than abstract.
 *
 * This is the ONE host string in the shipped CLI. When the service moves, this
 * line and the two READMEs are the whole change; nothing functional depends on it.
 */
const EXAMPLE_HOST = "https://relaymesh.io";

/**
 * The version, read from the manifest that npm actually published.
 *
 * It was a literal, and it went stale the moment the package shipped 0.2.0 —
 * `relay --version` told a user the truth about a build that no longer existed,
 * which is the one question a version flag has to get right when you are
 * debugging someone else's install. Read at runtime, it cannot drift.
 */
const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const program = new Command();

program
  .name("relay")
  .description("Move a company off a legacy system, from your terminal or your CI")
  .version(VERSION)
  .option("--url <baseUrl>", "the Relay deployment to talk to");

/**
 * Which deployment we are talking to, or a clear message about why we do not
 * know. No default host: the CLI attaches a live API key to every request, so
 * guessing one would leak the key to whoever owns the domain we guessed.
 */
function requireBase(): string {
  const base = baseUrl(program.opts<{ url?: string }>().url);
  if (!base) {
    fail(
      `No deployment configured.\n\n` +
        `  relay --url ${EXAMPLE_HOST} <command>\n` +
        `  RELAY_BASE_URL=${EXAMPLE_HOST}    or set it in the environment\n\n` +
        `There is no default on purpose — a fallback host would receive your API key.`,
    );
  }
  return base;
}

/** A client, or a clear message about why there isn't one. */
function client(): Relay {
  const base = requireBase();
  const key = apiKey(base);
  if (!key) {
    fail(
      `Not signed in to ${base}.\n\n` +
        `  relay login            paste a key from the console\n` +
        `  RELAY_API_KEY=...      or set it in the environment (CI should do this)\n\n` +
        `Create a key under Settings in the console.`,
    );
  }
  return new Relay({ apiKey: key, baseUrl: base });
}

/**
 * Turn an SDK error into something worth reading.
 *
 * The two typed errors get their own message because both mean "stop", not "try
 * again", and a caller who cannot tell will retry a 402 in a loop.
 */
async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      fail(`${err.message}\n\nBalance: ${money(err.balance)}`);
    }
    if (err instanceof MissingScopeError) {
      fail(
        `${err.message}\n\n` +
          `This key was minted without "${err.scope}". Mint one that has it under Settings ` +
          `in the console -- scopes cannot be added to an existing key.`,
      );
    }
    if (err instanceof RelayError) fail(err.message);
    fail((err as Error).message);
  }
}

// ── auth ─────────────────────────────────────────────────────────────────────

program
  .command("login")
  .description("Store an API key for this deployment")
  .option("--key <token>", "the key (prefer stdin -- argv is visible in `ps`)")
  .action(async (opts: { key?: string }) => {
    const base = requireBase();
    const key = opts.key ?? (await readStdin());
    if (!key) {
      fail(
        `No key given. Pipe it in:\n\n` +
          `  pbpaste | relay login\n` +
          `  echo -n 'relay_sk_...' | relay login`,
      );
    }
    if (!key.startsWith("relay_sk_")) {
      fail(`That does not look like a Relay key. They start with "relay_sk_".`);
    }

    // Verified before it is stored, so "logged in" means something. Storing an
    // unchecked key just moves the failure to the next command.
    const probe = new Relay({ apiKey: key, baseUrl: base });
    await run(async () => {
      await probe.runs.list();
      const path = saveKey(base, key);
      console.log(`${green("Signed in")} to ${base}`);
      console.log(dim(`Key stored in ${path} (0600).`));
    });
  });

program
  .command("logout")
  .description("Forget the stored key for this deployment")
  .action(() => {
    const base = requireBase();
    console.log(forgetKey(base) ? `Forgot the key for ${base}.` : `No key stored for ${base}.`);
  });

program
  .command("whoami")
  .description("Which deployment, and whether the key still works")
  .action(async () => {
    const base = requireBase();
    await run(async () => {
      const runs = await client().runs.list();
      const balance = await client().credits.balance();
      console.log(`${bold(base)}`);
      console.log(`  ${runs.length} run(s)`);
      console.log(
        `  balance ${balance.metered && balance.balance !== null ? money(balance.balance) : dim("not metered")}`,
      );
    });
  });

// ── runs ─────────────────────────────────────────────────────────────────────

const runs = program.command("runs").description("Start, watch, and steer migrations");

runs
  .command("start")
  .description("Queue a migration")
  .requiredOption("--source <system>", "system to move off, e.g. salesforce")
  .requiredOption("--dest <system>", "system to move onto, e.g. attio")
  .option("--source-org <label>", "what to call the source org", "Source")
  .option("--dest-org <label>", "what to call the destination", "Destination")
  .option("--source-url <url>", "entry URL for a live source")
  .option("--dest-url <url>", "entry URL for a live destination")
  .option("--source-credential <path>", "broker path, e.g. sf/readonly")
  .option("--dest-credential <path>", "broker path, e.g. attio/readonly")
  .option("--live", "point at real orgs rather than the demo fixtures", false)
  .option("--label <text>", "a name for the run")
  .option("--watch", "follow it until it rests or finishes", false)
  .action(async (opts) => {
    await run(async () => {
      const relay = client();
      const record = await relay.runs.create({
        mode: opts.live ? "live" : "fixture",
        source: {
          system: opts.source,
          orgLabel: opts.sourceOrg,
          ...(opts.sourceUrl ? { entryUrl: opts.sourceUrl } : {}),
          ...(opts.sourceCredential ? { credentialPath: opts.sourceCredential } : {}),
        },
        dest: {
          system: opts.dest,
          orgLabel: opts.destOrg,
          ...(opts.destUrl ? { entryUrl: opts.destUrl } : {}),
          ...(opts.destCredential ? { credentialPath: opts.destCredential } : {}),
        },
        ...(opts.label ? { label: opts.label } : {}),
      });
      console.log(`${green("Queued")} ${bold(record.runId)}  ${dim(record.label)}`);
      if (opts.watch) await follow(relay, record.runId);
      else console.log(dim(`  relay runs watch ${record.runId}`));
    });
  });

runs
  .command("list")
  .description("Every run, the ones that need you first")
  .action(async () => {
    await run(async () => {
      const rows = await client().runs.list();
      if (rows.length === 0) {
        console.log(dim("No runs yet."));
        return;
      }
      console.log(
        table([
          [dim("RUN"), dim("STATUS"), dim("MODE"), dim("LABEL"), dim("UPDATED")],
          ...rows.map((r) => [r.runId, status(r.status), r.mode, r.label, when(r.updatedAt)]),
        ]),
      );
    });
  });

runs
  .command("show <runId>")
  .description("What the agents have been up to on one run")
  .action(async (runId: string) => {
    await run(async () => {
      const detail = await client().runs.get(runId);
      console.log(`${bold(detail.record.label)}  ${status(detail.record.status)}`);
      console.log(dim(detail.view.headline));
      console.log("");

      for (const stage of detail.view.stages ?? []) {
        const mark = stage.status === "done" ? green("done") : stage.status === "failed" ? yellow("failed") : dim(stage.status);
        console.log(`  ${stage.id.padEnd(10)} ${mark}${stage.detail ? dim(` -- ${stage.detail}`) : ""}`);
      }

      const card = approvalCard(detail);
      if (card?.estimate) {
        console.log("");
        console.log(
          card.estimate.unknown
            ? dim("  Cutover cost unknown -- the source surfaced no record counts.")
            : `  Cutover estimate  ${bold(money(card.estimate.credits))}  ${dim(`(${card.estimate.records.toLocaleString()} records, ${card.estimate.rateVersion})`)}`,
        );
        if (card.spent !== undefined) console.log(`  Spent so far      ${money(card.spent)}`);
      }

      if (detail.view.pendingQuestion) {
        console.log("");
        console.log(yellow(`  ? ${detail.view.pendingQuestion.question}`));
        console.log(dim(`    relay runs reply ${runId} "<answer>"`));
      }
      if (detail.liveViewUrl) {
        console.log("");
        console.log(`  ${yellow("Take the wheel:")} ${cyan(detail.liveViewUrl)}`);
      }
    });
  });

runs
  .command("watch <runId>")
  .description("Follow a run until it rests or finishes")
  .action(async (runId: string) => {
    await run(async () => follow(client(), runId));
  });

runs
  .command("pause <runId>")
  .description("Stop at the next checkpoint. Resumable.")
  .action(async (runId: string) => {
    await run(async () => {
      await client().runs.pause(runId);
      console.log(`Asked ${runId} to pause.`);
    });
  });

runs
  .command("resume <runId>")
  .description("Carry on -- also how you restart a run that ran out of credits")
  .action(async (runId: string) => {
    await run(async () => {
      await client().runs.resume(runId);
      console.log(`${runId} re-queued.`);
    });
  });

runs
  .command("stop <runId>")
  .description("Stop now. Anything written is rolled back.")
  .action(async (runId: string) => {
    await run(async () => {
      await client().runs.stop(runId);
      console.log(`Asked ${runId} to stop.`);
    });
  });

runs
  .command("reply <runId> <answer>")
  .description("Answer whatever the agents asked")
  .action(async (runId: string, answer: string) => {
    await run(async () => {
      await client().runs.answer(runId, answer);
      console.log(`Answered ${runId}.`);
    });
  });

runs
  .command("approve <runId>")
  .description("Approve a run waiting at the gate. Needs the runs:approve scope.")
  .action(async (runId: string) => {
    await run(async () => {
      await client().runs.approve(runId);
      console.log(`${green("Approved")} ${runId}.`);
    });
  });

runs
  .command("reject <runId>")
  .description("Reject the plan")
  .option("--note <text>", "why")
  .action(async (runId: string, opts: { note?: string }) => {
    await run(async () => {
      await client().runs.reject(runId, opts.note);
      console.log(`Rejected ${runId}.`);
    });
  });

runs
  .command("tell <runId> <message...>")
  .description('Say something to a working run -- e.g. "skip Deal_Registration__c"')
  .action(async (runId: string, words: string[]) => {
    await run(async () => {
      await client().runs.message(runId, words.join(" "));
      console.log(`Sent to ${runId}.`);
    });
  });

// ── money ────────────────────────────────────────────────────────────────────

program
  .command("credits")
  .description("Balance and recent ledger entries")
  .action(async () => {
    await run(async () => {
      const balance = await client().credits.balance();
      if (!balance.metered || balance.balance === null) {
        console.log(dim("This deployment does not meter usage."));
        return;
      }
      console.log(`${bold(money(balance.balance))}  ${dim(`${balance.balance} credits`)}`);
      if (balance.entries.length > 0) {
        console.log("");
        console.log(
          table(
            balance.entries.map((e) => [
              (e.delta > 0 ? green : dim)(`${e.delta > 0 ? "+" : ""}${money(e.delta)}`),
              e.reason,
              dim(when(e.createdAt)),
            ]),
          ),
        );
      }
    });
  });

program
  .command("usage [runId]")
  .description("What runs have consumed, and what it cost")
  .action(async (runId?: string) => {
    await run(async () => {
      const usage = await client().credits.usage(runId);
      if (!usage.metered || usage.rows.length === 0) {
        console.log(dim("Nothing metered yet. Rehearsals are free."));
        return;
      }
      console.log(
        table([
          [dim("RUN"), dim("STAGE"), dim("UNIT"), dim("QTY"), dim("COST"), dim("RATE")],
          ...usage.rows.map((r) => [
            r.runId,
            r.stage,
            r.unit,
            r.quantity.toLocaleString(),
            money(r.credits),
            dim(r.rateVersion),
          ]),
        ]),
      );
      console.log("");
      console.log(`${bold("Total")}  ${money(usage.totalCredits)}`);
      if (usage.truncated) console.log(dim("(truncated -- narrow with a run id)"));
    });
  });

// ── credentials ──────────────────────────────────────────────────────────────

const creds = program.command("creds").description("The logins a scout signs in with");

creds
  .command("list")
  .description("Stored logins. Never shows a secret -- nothing can.")
  .action(async () => {
    await run(async () => {
      const rows = await client().credentials.list();
      if (rows.length === 0) {
        console.log(dim("No credentials stored."));
        return;
      }
      console.log(
        table([
          [dim("PATH"), dim("SYSTEM"), dim("USERNAME"), dim("UPDATED")],
          ...rows.map((c) => [
            c.orphaned ? yellow(c.path) : c.path,
            c.system,
            c.username ?? dim("-"),
            when(c.updatedAt),
          ]),
        ]),
      );
      if (rows.some((c) => c.orphaned)) {
        console.log("");
        console.log(
          yellow("Highlighted rows were sealed under a key that has since rotated. Re-enter them."),
        );
      }
    });
  });

creds
  .command("put <path>")
  .description('Store a login, e.g. "sf/readonly". Reads the secret from stdin.')
  .requiredOption("--system <name>", "the system it signs in to, e.g. salesforce")
  .option("--username <name>", "shown in the console so you can tell logins apart")
  .option("--label <text>", "a human label")
  .option("--token", "the secret is an API token rather than a password", false)
  .action(async (path: string, opts: { system: string; username?: string; label?: string; token: boolean }) => {
    // stdin by default: a password in argv shows up in `ps`, in shell history,
    // and in any process listing the machine's other users can read.
    const secret = await readStdin();
    if (!secret) {
      fail(`No secret given. Pipe it in:\n\n  echo -n 'hunter2' | relay creds put ${path} --system ${opts.system}`);
    }
    await run(async () => {
      await client().credentials.put(path, {
        system: opts.system,
        ...(opts.token ? { token: secret } : { password: secret }),
        ...(opts.username ? { username: opts.username } : {}),
        ...(opts.label ? { label: opts.label } : {}),
      });
      console.log(`${green("Stored")} ${path}.`);
    });
  });

creds
  .command("rm <path>")
  .description("Forget a login")
  .action(async (path: string) => {
    await run(async () => {
      await client().credentials.remove(path);
      console.log(`Removed ${path}.`);
    });
  });

// ── shared ───────────────────────────────────────────────────────────────────

/**
 * Follow a run, printing only what changed.
 *
 * The server sends the whole state on every event rather than a delta, so this
 * has to diff to avoid reprinting the same six stage lines every two seconds.
 */
async function follow(relay: Relay, runId: string): Promise<void> {
  let lastHeadline = "";
  let lastStatus = "";
  let announcedLiveView = "";

  for await (const event of relay.runs.watch(runId) as AsyncIterable<RunEvent>) {
    if (event.type === "gone") {
      console.log(yellow("That run is gone."));
      return;
    }
    if (event.type === "error") {
      fail(event.message);
    }
    if (event.type === "done") {
      console.log(`${bold("Finished")}  ${status(event.status)}`);
      return;
    }

    if (event.record.status !== lastStatus) {
      lastStatus = event.record.status;
      console.log(`  ${status(lastStatus)}`);
    }
    if (event.view.headline && event.view.headline !== lastHeadline) {
      lastHeadline = event.view.headline;
      console.log(`  ${dim(lastHeadline)}`);
    }
    if (event.liveViewUrl && event.liveViewUrl !== announcedLiveView) {
      announcedLiveView = event.liveViewUrl;
      console.log(`  ${yellow("Take the wheel:")} ${cyan(event.liveViewUrl)}`);
    }
    const question = event.view.pendingQuestion;
    if (question) {
      console.log(`  ${yellow("?")} ${question.question}`);
      console.log(`    ${dim(`relay runs reply ${runId} "<answer>"`)}`);
    }
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

program.parseAsync(process.argv).catch((err: Error) => fail(err.message));
