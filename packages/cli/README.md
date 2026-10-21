# @userelay/cli

Relay from your terminal.

```bash
npm install -g @userelay/cli

export RELAY_BASE_URL=https://relaymesh.io   # your deployment
pbpaste | relay login                        # paste a key from Settings
```

Or pass it per command: `relay --url https://relaymesh.io runs list`.

CI should set `RELAY_API_KEY` instead of logging in — the environment always
wins over the stored config, so a machine behaves the same as the command you
tested by hand.

**There is no default host.** The CLI attaches a live API key to every request,
and a fallback domain we do not own would receive it on the first
misconfiguration. It refuses to run instead — which also means moving the
service later is one environment variable, not a republish.

```bash
relay runs start --source salesforce --dest attio --live --watch
relay runs list
relay runs show run-2026...
relay runs reply run-2026... "skip Deal_Registration__c"
relay credits
relay usage run-2026...
```

`relay runs approve` needs a key minted with the `runs:approve` scope. Ordinary
keys can start migrations and read the plan, but not sign off on writing to a
customer's live system — that's the point.

Everything here goes over HTTP through [`@userelay/sdk`](../sdk). There is no
database client in this package, deliberately: one implementation per verb, and
the one we use daily is the one customers use.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
