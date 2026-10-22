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

Relay's backend is private; these two packages are not. They are a typed way to
call an HTTP API you already have a key for.

## Working on them

```bash
npm install
npm run build
npm test
```

An npm workspace. The SDK has zero runtime dependencies and targets Node 18+;
the CLI depends on the SDK and on `commander`. Both build with `tsc`.

## Releases

`npm stage publish` from CI, approved with 2FA before anything reaches the
registry. Each version carries a Sigstore provenance attestation binding it to
the commit it was built from — verify with `npm audit signatures`.

## Licence

Apache-2.0. See [LICENSE](packages/sdk/LICENSE) and [NOTICE](packages/sdk/NOTICE).
