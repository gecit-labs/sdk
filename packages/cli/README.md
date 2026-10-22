# @userelay/cli

Relay from your terminal.

```bash
npm install -g @userelay/cli

export RELAY_BASE_URL=https://relaymesh.io   # your deployment
pbpaste | relay login                        # paste a key from Settings
```

Or per command: `relay --url https://relaymesh.io runs list`.

There is no default host — it refuses to run without one.

In CI, set `RELAY_API_KEY` instead of logging in. The environment wins over
stored config, so a machine behaves the same as the command you tested by hand.

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
live system.

Everything goes over HTTP through [`@userelay/sdk`](../sdk).

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
