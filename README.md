# oxigraph-cloudflare-webworker

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) that fetches
a small Turtle file from a static website, loads it into an in-memory
[Oxigraph](https://github.com/oxigraph/oxigraph) store (compiled to
WebAssembly), and serves it as a read-only SPARQL 1.1 query endpoint at the
edge.

## How it works

- [`oxigraph`](https://www.npmjs.com/package/oxigraph)'s `web` build ships a
  `web_bg.wasm` file and a `web.js` glue module. Its default `init()` fetches
  the `.wasm` file relative to `import.meta.url`, which doesn't resolve for a
  file bundled into a Worker. Instead, `src/store.ts` imports the `.wasm`
  file directly — Wrangler's bundler turns that into a `WebAssembly.Module`
  automatically — and passes it to `initSync()`, so no fetch of the wasm
  binary itself is needed.
- On the first request a Worker isolate handles, `src/store.ts` fetches
  `env.TURTLE_URL`, parses it as Turtle, and loads it into a new `Store`. That
  store is then cached at module scope and reused for every later request the
  same isolate handles (an isolate can be reused for many requests, but isn't
  guaranteed to live forever — a cold start reloads the data). A failed fetch
  is not cached, so a transient error doesn't permanently break the isolate.
- `src/index.ts` implements a minimal read-only [SPARQL 1.1
  Protocol](https://www.w3.org/TR/sparql11-protocol/) endpoint at `/sparql`:
  `GET`/`POST` with a `query` parameter, or `POST` with a body of content
  type `application/sparql-query`. There is deliberately no SPARQL Update
  support — this is a public, unauthenticated endpoint over data it doesn't
  own.
- The `Accept` header picks the result format directly from Oxigraph's
  `results_format` query option (see `src/content-negotiation.ts`), so
  Oxigraph does the serialization (SPARQL JSON/XML/CSV/TSV for
  `SELECT`/`ASK`, Turtle/N-Triples/N-Quads/TriG/RDF-XML for
  `CONSTRUCT`/`DESCRIBE`) — no hand-rolled serialization code.

## Setup

```sh
npm install
```

Edit `wrangler.jsonc` and set `vars.TURTLE_URL` to the URL of your own
Turtle file (it currently points at a placeholder). After changing
`wrangler.jsonc`, regenerate the generated type declarations:

```sh
npm run cf-typegen
```

## Development

```sh
npm run dev
```

Then, for example:

```sh
curl "http://localhost:8787/sparql?query=SELECT+%3Fs+%3Fp+%3Fo+WHERE+%7B+%3Fs+%3Fp+%3Fo+%7D"
curl -H "Accept: text/turtle" "http://localhost:8787/sparql?query=CONSTRUCT+%7B+%3Fs+%3Fp+%3Fo+%7D+WHERE+%7B+%3Fs+%3Fp+%3Fo+%7D"
curl -X POST -H "Content-Type: application/sparql-query" --data 'ASK { ?s ?p ?o }' http://localhost:8787/sparql
```

To point a local dev run at a different Turtle file without editing
`wrangler.jsonc`, use `--var`:

```sh
npx wrangler dev --var TURTLE_URL:http://localhost:8793/data.ttl
```

## Tests

```sh
npm test
```

Tests run against the real Workers runtime via
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/)
(no network access needed — the fixture Turtle data is loaded from a `data:`
URL).

## Deploy

```sh
npm run deploy
```

## Limitations

- Read-only: no SPARQL Update.
- One dataset per Worker, fixed at `TURTLE_URL`; it isn't re-fetched once an
  isolate has loaded it.
- CORS is wide open (`Access-Control-Allow-Origin: *`), matching how most
  public SPARQL endpoints behave. Tighten `CORS_HEADERS` in `src/index.ts` if
  that's not appropriate for your data.
