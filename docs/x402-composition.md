# x402 fetch hook composition contract

For extension authors wrapping fetch alongside this extension's payment hook.
Everything stated here is pinned by `test/x402-composition.test.ts` and
`test/x402-hook.test.ts`; treat those tests as the source of truth if this
document and the code ever disagree.

## The marker

The paying fetch is a `Proxy` carrying:

```ts
const X402_FETCH_MARKER = Symbol.for("pi-surplus-intelligence:x402-fetch");
```

`Symbol.for` is deliberate: separately-bundled copies of the extension
recognize each other's hooks. The marker is non-enumerable —
`Object.keys`, spread, and `JSON.stringify` never see it — but
`fetchFn[X402_FETCH_MARKER]` and `X402_FETCH_MARKER in fetchFn` work.

## The descriptor

```ts
type PayingFetchMarker = {
  version: 1;
  inner: typeof fetch;        // the original, un-wrapped fetch
  config: PayingFetchConfig;  // mutable; re-wrapping updates it in place
};
```

## The rules

1. **One payment loop per fetch chain.** Wrapping an already-marked fetch
   updates its `config` and returns the same Proxy. `inner` still points at
   the original base fetch. Double-installation is structurally impossible.
2. **Payment stays innermost by default.** Hooks wrapping the paying fetch
   (outside) see only the final settled response — a handled 402 never
   escapes. Hooks that need to observe the challenge can wrap `inner` and
   re-apply the payment hook around themselves.
3. **Bodies survive.** The hook clones the request before the challenge
   round-trip and clones the 402 response before parsing, so an outer hook
   can always read the final body bytes.
4. **No wallet, no hook.** When payments are unconfigured the hook is not
   installed at all; `globalThis.fetch` keeps its identity.

## Example

```ts
const paying = createPayingFetch(fetch, config);      // innermost
const logged  = loggingFetch(paying);                  // sees settled only
const retried = retryFetch(logged);                    // outermost
```

To observe challenges instead:

```ts
const marker = paying[X402_FETCH_MARKER];
const innerLogged = loggingFetch(marker.inner);
const paying2 = createPayingFetch(innerLogged, marker.config); // paying inside logging
```

## Global install

`installPayingFetch(globalThis, config)` wraps the global fetch idempotently;
`uninstallPayingFetch(globalThis)` restores the exact prior function. The
extension runs these at session start and shutdown; other extensions should
prefer `createPayingFetch` on their own call sites over touching the global.
