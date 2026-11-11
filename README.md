# oxigraph-cloudflare-webworker

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) that fetches
a small RDF file (any format Oxigraph reads, such as Turtle, JSON-LD, RDF/XML
or N-Triples) from a static website, loads it into an in-memory
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
The format comes from the file extension (`.ttl`, `.nt`, `.jsonld`, `.rdf`,
`.owl` and [more](#data-file), optionally gzipped) unless you say otherwise.

Some examples:

```sh
# A Turtle file
npm run new-worker -- books https://example.org/data/books.ttl

# A gzipped JSON-LD file, e.g. one using "@context": "https://schema.org/"
npm run new-worker -- people https://example.org/data/people.jsonld.gz

# An OWL ontology in RDF/XML
npm run new-worker -- onto https://example.org/ontology/core.owl

# A gzipped N-Triples dump
npm run new-worker -- dump https://example.org/data/dump.nt.gz

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

Or open the Worker's address, or that `/sparql` URL, in a browser for a
[query editor](#query-editor).

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
  `env.DATA_URL`, parses it in whichever RDF format it's in (see
  [Data file](#data-file)), and loads it into a new `Store`. That
  store is then cached at module scope and reused for every later request the
  same isolate handles (an isolate can be reused for many requests, but isn't
  guaranteed to live forever — a cold start reloads the data). A failed fetch
  is not cached, so a transient error doesn't permanently break the isolate.
- `src/index.ts` implements a minimal read-only [SPARQL 1.1
  Protocol](https://www.w3.org/TR/sparql11-protocol/) endpoint at `/sparql`:
  `GET`/`POST` with a `query` parameter, or `POST` with a body of content
  type `application/sparql-query`. A query in a `POST` body wins over a
  `?query=` in the URL. `default-graph-uri` and `named-graph-uri` pick the
  dataset (in the URL, or in a URL-encoded `POST` body), replacing the
  query's own `FROM` and `FROM NAMED` as the protocol specifies; giving only
  one of them leaves the other empty. There is deliberately no SPARQL Update
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
| `DATA_FORMAT` | from the file extension, see below                        | a media type from the table below                |
| `DATA_ACCEPT` | asks for the format, e.g. `text/turtle, */*;q=0.1`        | any `Accept` header value                        |

Every format Oxigraph parses is supported. The list lives in
`src/formats.json`, which the Worker and `npm run new-worker` both read:

| Format    | Extensions        | Media type (`DATA_FORMAT`) | `--format` |
| --------- | ----------------- | -------------------------- | ---------- |
| Turtle    | `.ttl`            | `text/turtle`              | `turtle`   |
| JSON-LD   | `.jsonld`, `.json`| `application/ld+json`      | `jsonld`   |
| RDF/XML   | `.rdf`, `.owl`    | `application/rdf+xml`      | `rdfxml`   |
| N-Triples | `.nt`             | `application/n-triples`    | `ntriples` |
| N-Quads   | `.nq`             | `application/n-quads`      | `nquads`   |
| TriG      | `.trig`           | `application/trig`         | `trig`     |
| N3        | `.n3`             | `text/n3`                  | `n3`       |

`--format` also takes a file extension or the media type, so `--format nt`
and `--format application/n-triples` both mean N-Triples.

- A trailing `.gz` is looked through, so `data.ttl.gz` is Turtle.
- A URL without one of those extensions, typically a content-negotiated one
  like a `w3id.org` or PURL redirect, is parsed according to the
  `Content-Type` it is served with. If that isn't one of the media types
  above either, loading fails with a `502` asking you to set `DATA_FORMAT`.
  Without a known format, the default `Accept` lists every format, in the
  order of the table, each with a slightly lower preference.
- `.owl` is read as RDF/XML because that's what nearly all `.owl` files
  are, including Protégé's default output (DTD entities and `xml:base` work).
  An `.owl` file in Turtle needs `DATA_FORMAT` set to `text/turtle`. The
  separate OWL/XML syntax (`application/owl+xml`) isn't RDF, and Oxigraph
  can't read it.
- Named graphs in N-Quads, TriG or JSON-LD data stay named graphs. SPARQL
  queries see only the default graph unless they use `GRAPH`, so a plain
  `SELECT * WHERE { ?s ?p ?o }` won't return them, unless the request names
  them with `default-graph-uri`.
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

## Query editor

The home page, `/`, is always a page with the
[SIB SPARQL editor](https://github.com/sib-swiss/sparql-editor) (built on
YASGUI), set up to query the endpoint. `/sparql` serves the same page to a
browser opening it without a query: any request without a query whose
`Accept` header lists `text/html` or `application/xhtml+xml` gets the
page. Other clients, including `curl` with its `*/*`, still get a `400` for a
missing query, and a request with a query is answered as before.

- The editor's script loads from [esm.sh](https://esm.sh), pinned to one
  version in `src/editor-page.ts`.
- The page comes with a minimal stylesheet (`DEFAULT_CSS` in
  `src/editor-page.ts`). To use your own instead, set `EDITOR_CSS_URL` to
  the URL of a stylesheet, or pass `--editor-css <url>` to
  `npm run new-worker`. It replaces the default rather than adding to it, so
  copy the default as a starting point. The editor's button colours are the
  `--btn-color` and `--btn-bg-color` custom properties.
- The editor fills its autocomplete and example list from a
  [VoID description](https://www.w3.org/TR/void/) and
  [SHACL query examples](https://github.com/sib-swiss/sparql-examples) in the
  data itself. Without them it still works.
- `PUBLIC_ENDPOINT_URL` is the endpoint's public URL, such as
  `https://sparql.example.org/sparql` behind a custom domain. The editor
  queries it, and it names the prefix graph below. Leave it empty for
  `/sparql` on whatever address the Worker is reached at; `npm run new-worker`
  sets it with `--endpoint-url <url>`.

### Prefixes

The editor offers the prefixes an endpoint declares in the
[sparql-examples](https://github.com/sib-swiss/sparql-examples) style, as
SHACL prefix declarations. For a Turtle, TriG, N3 or RDF/XML data file, the
Worker reads the prefixes the file declares (`@prefix`/`PREFIX` lines, or
`xmlns:` attributes) and adds them in that style:

```turtle
_:prefixes a owl:Ontology ;
  owl:imports sh: ;
  sh:declare _:prefix_schema .
_:prefix_schema sh:prefix "schema" ;
  sh:namespace "https://schema.org/"^^xsd:anyURI .
```

They go in the graph `<PUBLIC_ENDPOINT_URL/.well-known/sparql-examples/>`,
where the editor also looks for query examples by default, e.g.
`<https://sparql.example.org/sparql/.well-known/sparql-examples/>`.

- A copy also goes in the default graph, because the editor asks for
  prefixes without a `GRAPH` clause, and the default graph here doesn't
  include named graphs. So a query over the whole default graph, like
  `SELECT (COUNT(*) AS ?n) { ?s ?p ?o }`, counts these declarations too.
- The empty prefix (`@prefix : <...>`), `xmlns:xml` and namespaces written
  as XML entity references (`xmlns:ex="&ex;"`) are skipped. Relative
  namespaces are resolved against `DATA_URL`.
- Without `PUBLIC_ENDPOINT_URL`, the graph is named after the address of
  the request that made the Worker load its data. An endpoint reached at
  more than one address, like `workers.dev` and a custom domain, should set
  it.
- JSON-LD, N-Triples and N-Quads have no prefix declarations to read.

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
  by the file extension. Override them with `--format <format>` (e.g.
  `--format ntriples`) and `--accept '<header>'`. For a URL without a known
  extension, the command warns that the format will come from the served
  `Content-Type`.
- `--endpoint-url <url>` sets `PUBLIC_ENDPOINT_URL`, for an endpoint
  behind a custom domain, see [Query editor](#query-editor).
- `--editor-css <url>` sets the stylesheet of the
  [query editor](#query-editor) page.
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

For JSON-LD data, Oxigraph's own JSON-LD parser reads the file. Its
JavaScript API has no way to load remote contexts, though, so a document
using `"@context": "https://schema.org/"`
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
cycles. `test/data-source.spec.ts` covers how the data file is fetched and
read: the format from the file extension or `Content-Type`, the
`DATA_FORMAT` and `DATA_ACCEPT` overrides, the `Accept` header sent,
loading every supported format, named graphs, and gzipped files.
`test/editor-page.spec.ts` covers when the query editor page is served, and
its CSS override. `test/prefixes.spec.ts` covers reading prefixes from
Turtle and RDF/XML, and the SHACL declarations made from them.

## Deploy

```sh
npm run deploy
```

By default this runs against whatever account `wrangler login` last
authenticated — an OAuth grant that covers every Cloudflare product on the
account (KV, R2, D1, routes, ...), not just what this Worker uses. This
project has no bindings besides plain vars and no custom route, so the
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
- `/robots.txt` disallows `/sparql` for all crawlers, since every query
  costs CPU time and a crawler following query links could run many. Only
  well-behaved crawlers honour it; it is not access control.
- CORS is wide open (`Access-Control-Allow-Origin: *`), matching how most
  public SPARQL endpoints behave. Tighten `CORS_HEADERS` in `src/index.ts` if
  that's not appropriate for your data.
