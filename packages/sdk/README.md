# @userelay/sdk

Move a company off a legacy system, from your own code.

```bash
npm install @userelay/sdk
```

Zero runtime dependencies. Node 18+.

## Pointing it at your deployment

```bash
RELAY_API_KEY=relay_sk_...            # Settings → API keys, in the console
RELAY_BASE_URL=https://relaymesh.io   # your deployment
```

Both can be passed to the constructor instead. **There is no default host**, and
that is deliberate: this client attaches `Authorization: Bearer relay_sk_…` to
every request, so a built-in fallback would hand a live key to whoever owns that
domain the first time someone forgot to configure it. It throws instead.

It also means moving the service to a new domain is a config change and never a
release — nothing in this package knows where it lives.

## Start a migration and follow it

```ts
import { Relay, approvalCard } from "@userelay/sdk";

const relay = new Relay({
  apiKey: process.env.RELAY_API_KEY,
  baseUrl: "https://relaymesh.io",
});

const run = await relay.runs.create({
  mode: "live",
  source: {
    system: "salesforce",
    orgLabel: "Acme prod",
    entryUrl: "https://acme.my.salesforce.com",
    credentialPath: "sf/readonly",
  },
  dest: { system: "attio", orgLabel: "Acme Attio" },
});

for await (const event of relay.runs.watch(run.runId)) {
  if (event.type !== "run") continue;

  // Someone needs to clear an SSO or MFA prompt. This happens once per org, ever.
  if (event.liveViewUrl) await pageOnCall(event.liveViewUrl);

  // The plan is ready and nothing has been written yet. The card belongs to the
  // open question rather than to the run, so `approvalCard` finds it for you.
  const card = approvalCard(event);
  if (card) console.log(`${card.objectsMapped} objects, est. ${card.estimate?.credits} credits`);

  // It asked you something.
  const question = event.view.pendingQuestion;
  if (question) await relay.runs.answer(run.runId, "yes");
}
```

`watch()` reconnects on its own. A live migration is minutes of browser work with
a human pause in the middle, so the connection *will* be dropped by something —
the stream survives that and ends only when the run does. Every event carries the
whole run state rather than a delta, so a reconnect can never miss a transition.

## Approving is deliberately hard

Nothing reaches a customer's live system until a human approves it. A key can
only approve if it was minted with the `runs:approve` scope, which is **not** in
the default set:

```ts
try {
  await relay.runs.approve(run.runId);
} catch (err) {
  if (err instanceof MissingScopeError) {
    // Expected on an ordinary CI key. Hand it to a person instead.
  }
}
```

The default scopes — `runs:read`, `runs:write`, `usage:read` — let a script start
a migration, watch it, read the plan, and answer questions about fields. They do
not let it sign off on writing to production.

## Errors you should branch on

| | means | retry? |
|---|---|---|
| `InsufficientCreditsError` | 402, the workspace is out of credits | never |
| `MissingScopeError` | 403, this key can't do that — carries `.scope` | never |
| `AuthenticationError` | 401, key absent, revoked, or expired | never |
| `NotFoundError` | 404, or not yours — the API doesn't distinguish | never |
| `RelayError` | anything else, with `.status` | maybe |

The client retries a `GET` through connection errors and 5xx. It never retries a
`POST`: there is no idempotency key for run creation, so a replayed request is a
second migration against a real org.

## Credits

One credit is one US cent.

```ts
const { balance, entries } = await relay.credits.balance();
const usage = await relay.credits.usage(run.runId);
```

Rehearsals are free — only a real cutover is billed. A run that exhausts its
balance mid-flight **rests** rather than failing: top up, call
`relay.runs.resume(id)`, and it carries on from where it stopped.

## Credentials

```ts
await relay.credentials.put("sf/readonly", {
  system: "salesforce",
  username: "svc-migration@acme.com",
  password: process.env.SF_PASSWORD,
});
```

Needs the `credentials:write` scope. Nothing can read a secret back — there is no
endpoint that unseals, by design.

## What this client can't do

- **Mint or revoke keys.** Those need a session in the console. If a key could
  mint a key, a leaked read-only token would escalate itself.
- **Add credits.** A workspace topping up its own balance is a free-money
  endpoint.
- **Drive the browser during a takeover.** `runs.takeover()` gives you a URL for
  a person to open. Clearing an MFA challenge is a human's job.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
