# Relay SDK and CLI

The client side of [Relay](https://relaymesh.io) — agent infrastructure for
moving a company off a legacy system. Apache-2.0.

| | npm | what it is |
|---|---|---|
| [`packages/sdk`](packages/sdk) | [`@userelay/sdk`](https://www.npmjs.com/package/@userelay/sdk) | Start a migration from your own code, watch it, answer it |
| [`packages/cli`](packages/cli) | [`@userelay/cli`](https://www.npmjs.com/package/@userelay/cli) | The same verbs from a terminal or from CI |

```bash
npm install @userelay/sdk
npm install -g @userelay/cli
```

## Why these are public and the service is not

Relay's backend is private. These two packages are not, because they are
nothing more than a typed way to call an HTTP API that you already have a key
for — there is no advantage to anyone in keeping that shape secret, and real
cost to a customer who has to guess at it.

Publishing them also makes one design decision checkable rather than
asserted. Neither package has a default host:

> There is no default host, and that is deliberate: this client attaches
> `Authorization: Bearer relay_sk_…` to every request, so a built-in fallback
> would hand a live key to whoever owns that domain the first time someone
> forgot to configure it. It throws instead.

You can read that for yourself here instead of taking our word for it. The same
reasoning is why `relay runs approve` requires a key minted with the
`runs:approve` scope: an ordinary key can start a migration and read the plan,
but not sign off on writing to a customer's live system.

## Layout

The SDK has zero runtime dependencies and targets Node 18+. The CLI depends on
the SDK and on `commander`, and deliberately holds no database client — one
implementation per verb, and the one we use daily is the one customers use.

## Working on them

```bash
cd packages/sdk && npm install && npm run build && npm test
cd packages/cli && npm install && npm run build
```

Both are built with `tsc` against `tsconfig.build.json`.

## Licence

Apache-2.0. See [LICENSE](packages/sdk/LICENSE) and [NOTICE](packages/sdk/NOTICE).
