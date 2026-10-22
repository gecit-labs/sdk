# @userelay/sdk

Move a company off a legacy system, from your own code.

```bash
npm install @userelay/sdk
```

Zero runtime dependencies. Node 18+.

## Configure

```bash
RELAY_API_KEY=relay_sk_...            # Settings → API keys, in the console
RELAY_BASE_URL=https://relaymesh.io   # your deployment
```

Or pass both to the constructor. There is no default host — it throws if the
base URL is unset, rather than sending your key somewhere you didn't choose.

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

  // Someone needs to clear an SSO or MFA prompt. Once per org.
  if (event.liveViewUrl) await pageOnCall(event.liveViewUrl);

  // The plan is ready. Nothing has been written yet.
  const card = approvalCard(event);
  if (card) console.log(`${card.objectsMapped} objects, est. ${card.estimate?.credits} credits`);

  const question = event.view.pendingQuestion;
  if (question) await relay.runs.answer(run.runId, "yes");
}
```

`watch()` reconnects on its own and ends only when the run does. Every event
carries the whole run state rather than a delta, so a reconnect can't miss a
transition.

## Approving

Nothing reaches a live system until a human approves it. Approval needs a key
minted with `runs:approve`, which is not in the default set:

```ts
try {
  await relay.runs.approve(run.runId);
} catch (err) {
  if (err instanceof MissingScopeError) {
    // Expected on an ordinary CI key. Hand it to a person.
  }
}
```

Default scopes are `runs:read`, `runs:write` and `usage:read` — enough to start
a migration, watch it, read the plan and answer questions about fields.

## Errors

| | means | retry? |
|---|---|---|
| `InsufficientCreditsError` | 402, out of credits | never |
| `MissingScopeError` | 403, this key can't do that — carries `.scope` | never |
| `AuthenticationError` | 401, key absent, revoked, or expired | never |
| `NotFoundError` | 404, or not yours — the API doesn't distinguish | never |
| `RelayError` | anything else, with `.status` | maybe |

`GET`s retry through connection errors and 5xx. `POST`s never retry: run
creation has no idempotency key, so a replayed request is a second migration
against a real org.

## Credits

One credit is one US cent.

```ts
const { balance, entries } = await relay.credits.balance();
const usage = await relay.credits.usage(run.runId);
```

Rehearsals are free; only a real cutover is billed. A run that exhausts its
balance rests instead of failing — top up and call `relay.runs.resume(id)`.

## Credentials

```ts
await relay.credentials.put("sf/readonly", {
  system: "salesforce",
  username: "svc-migration@acme.com",
  password: process.env.SF_PASSWORD,
});
```

Needs `credentials:write`. Secrets can't be read back; there is no endpoint
that unseals one.

## Not in this client

- **Minting or revoking keys** — needs a console session.
- **Adding credits** — operator-side only.
- **Driving the browser during a takeover** — `runs.takeover()` returns a URL
  for a person to open.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
