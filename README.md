# oxigraph-cloudflare-webworker

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) that fetches
a small Turtle or JSON-LD file from a static website, loads it into an in-memory
[Oxigraph](https://github.com/oxigraph/oxigraph) store (compiled to
WebAssembly), and serves it as a read-only SPARQL 1.1 query endpoint at the
edge.

## TL;DR

Install once, log in to Cloudflare, then create a named SPARQL endpoint for
any RDF file with a single command:

```sh
npm install
npx wrangler login
npm run new-worker -- <name> <data-url>
```

The Worker goes live at `https://<name>.<your-subdomain>.workers.dev/sparql`.
The format comes from the file extension (`.ttl`, `.jsonld`, `.json`,
optionally gzipped) unless you say otherwise.

Some examples:

```sh
# A Turtle file
npm run new-worker -- books https://example.org/data/books.ttl

# A gzipped JSON-LD file, e.g. one using "@context": "https://schema.org/"
npm run new-worker -- people https://example.org/data/people.jsonld.gz

# A content-negotiated URL without an extension: set the format and the
# Accept header to request explicitly
npm run new-worker -- thing https://w3id.org/example/thing \
  --format jsonld --accept 'application/ld+json'

# Only write workers/staging.jsonc, try it locally, then create it
npm run new-worker -- staging https://example.org/data/books.ttl --no-deploy
npx wrangler dev -c workers/staging.jsonc
npx wrangler deploy -c workers/staging.jsonc

# Point an existing endpoint at a new file
npm run new-worker -- books https://example.org/data/books-v2.ttl --force
```

Then query it:

```sh
curl 'https://books.<your-subdomain>.workers.dev/sparql' \
  --data-urlencode 'query=SELECT * WHERE { ?s ?p ?o } LIMIT 10' -G
```

Run `npm run new-worker -- --help` for all options. The rest of this README
explains how it works, the [data file settings](#data-file), and
[deploying with a minimal-permission token](#deploy) instead of
`wrangler login`.

## How it works

- [`oxigraph`](https://www.npmjs.com/package/oxigraph)'s `web` build ships a
  `web_bg.wasm` file and a `web.js` glue module. Its default `init()` fetches
  the `.wasm` file relative to `import.meta.url`, which doesn't resolve for a
  file bundled into a Worker. Instead, `src/store.ts` imports the `.wasm`
  file directly — Wrangler's bundler turns that into a `WebAssembly.Module`
  automatically — and passes it to `initSync()`, so no fetch of the wasm
  binary itself is needed.
- On the first request a Worker isolate handles, `src/store.ts` fetches
  `env.DATA_URL`, parses it as Turtle or JSON-LD (see
  [Data file](#data-file)), and loads it into a new `Store`. That
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

Edit `wrangler.jsonc` and set `vars.DATA_URL` to the URL of your own data
file (it currently points at a placeholder). Or skip editing it and create a
separately named Worker instead, see [below](#create-a-new-named-worker).
After changing `wrangler.jsonc`, regenerate the generated type declarations:

```sh
npm run cf-typegen
```

### Data file

Three vars control how `DATA_URL` is fetched and parsed. Only `DATA_URL` is
required:

| Var           | Default                                                    | Override with                                    |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `DATA_URL`    | none                                                       | the file's URL                                   |
| `DATA_FORMAT` | from the extension: `.ttl` is Turtle, `.jsonld` and `.json` are JSON-LD | `text/turtle` or `application/ld+json` |
| `DATA_ACCEPT` | asks for the format, e.g. `text/turtle, */*;q=0.1`        | any `Accept` header value                        |

- A trailing `.gz` is looked through, so `data.ttl.gz` is Turtle.
- A URL without one of those extensions, typically a content-negotiated one
  like a `w3id.org` or PURL redirect, is parsed according to the
  `Content-Type` it is served with. If that isn't `text/turtle` or
  `application/ld+json` either, loading fails with a `502` asking you to set
  `DATA_FORMAT`. Without a known format, the default `Accept` asks for
  Turtle first, then JSON-LD.
- Set `DATA_ACCEPT` when a server needs something else to return RDF, for
  example a stricter header without the `*/*` fallback.

Gzipped data works both ways it can arrive:

- Compressed in transit (`Content-Encoding: gzip`, which most static hosts
  and CDNs do by themselves): Workers' `fetch` undoes that transparently.
- A file that is itself gzipped, like `data.jsonld.gz` served as
  `application/gzip`: recognised by gzip's magic bytes and decompressed.

Either way, what counts against the Worker's 128 MB memory limit is the
uncompressed data, plus Oxigraph's store built from it.

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

To point a local dev run at a different data file without editing
`wrangler.jsonc`, use `--var`:

```sh
npx wrangler dev --var DATA_URL:http://localhost:8793/data.ttl
npx wrangler dev --var DATA_URL:http://localhost:8793/data.jsonld.gz
npx wrangler dev --var DATA_URL:http://localhost:8793/negotiated --var DATA_FORMAT:application/ld+json
```

## Create a new named Worker

One command names, configures and creates a new endpoint Worker:

```sh
npm run new-worker -- people https://example.org/people.jsonld
```

This writes `workers/people.jsonc`, a Wrangler config that reuses this
repo's `src/` with its own `name` and [data file vars](#data-file), and then
runs `wrangler deploy` on it. The first deploy of a new name is what creates
the Worker on Cloudflare, at `people.<your-subdomain>.workers.dev`. Every
endpoint shares the same code, so a code change reaches all of them on their
next deploy.

- The format and `Accept` header follow the [defaults](#data-file), going
  by the file extension. Override them with `--format turtle` or
  `--format jsonld`, and `--accept '<header>'`. For a URL without a known
  extension, the command warns that the format will come from the served
  `Content-Type`.
- `--no-deploy` only writes the config. Try it locally with
  `npx wrangler dev -c workers/people.jsonc`, then create it with
  `npx wrangler deploy -c workers/people.jsonc`.
- An existing `workers/<name>.jsonc` is never overwritten unless you pass
  `--force`.
- Names follow Cloudflare's rules: 1-63 lowercase letters, digits and
  dashes, not starting or ending with a dash.

Deploying uses the same credentials as `npm run deploy`, see
[Deploy](#deploy).

## JSON-LD

For JSON-LD data, Oxigraph's own JSON-LD parser reads the file. Its JavaScript API has no way to load remote
contexts, though, so a document using `"@context": "https://schema.org/"`
would fail on its own. `src/jsonld-contexts.ts` fills that gap: before
parsing, it fetches every remote context the document refers to (including
contexts inside other contexts, `@import`, and scoped contexts on term
definitions) and inlines it. A context URL that answers with HTML and a
`Link: <...>; rel="alternate"; type="application/ld+json"` header, as
`https://schema.org/` does, is followed to its JSON-LD version.

- Each remote context is fetched once per data load, and at most 20
  distinct remote contexts are allowed. A context that includes itself is
  rejected.
- Contexts are fetched by the Worker at load time, so a context host being
  down fails the load (a `502`), just like the data URL being down.
- schema.org's context maps terms to `http://schema.org/` IRIs, not
  `https://`, so query with `http://schema.org/name` and so on.

## Tests

```sh
npm test
```

Tests run against the real Workers runtime via
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/)
(no network access needed — the fixture Turtle and JSON-LD data, and a
remote JSON-LD context, are loaded from `data:` URLs).
`test/jsonld.spec.ts` also covers context inlining with a fake `fetch`:
`Link` header alternates, relative URLs, `@import`, scoped contexts and
cycles.

## Deploy

```sh
npm run deploy
```

By default this runs against whatever account `wrangler login` last
authenticated — an OAuth grant that covers every Cloudflare product on the
account (KV, R2, D1, routes, ...), not just what this Worker uses. This
project has no bindings besides a plain var and no custom route, so the
actual minimum is a single permission. To scope it down:

1. At <https://dash.cloudflare.com/profile/api-tokens>, choose **Create
   Custom Token**.
2. Grant only **Account → Workers Scripts → Edit**, and under **Account
   Resources** select the one specific account this Worker deploys to (not
   "All accounts").
3. Use that token instead of an OAuth login session:

   ```sh
   export CLOUDFLARE_API_TOKEN=<the token>
   export CLOUDFLARE_ACCOUNT_ID=<your account id>  # only needed if wrangler can't infer a single account from the token
   npm run deploy
   ```

If you later add a KV namespace, D1 database, R2 bucket, or a custom
route/domain, add the matching permission group to the token — deploying
those needs more than Workers Scripts:Edit.

## Limitations

- Read-only: no SPARQL Update.
- One dataset per Worker, fixed at `DATA_URL`; it isn't re-fetched once an
  isolate has loaded it. Use `npm run new-worker` for more datasets.
- CORS is wide open (`Access-Control-Allow-Origin: *`), matching how most
  public SPARQL endpoints behave. Tighten `CORS_HEADERS` in `src/index.ts` if
  that's not appropriate for your data.
