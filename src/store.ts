import { initSync, Store } from "oxigraph/web.js";
import wasmModule from "oxigraph/web_bg.wasm";
import formats from "./formats.json";
import { inlineRemoteContexts } from "./jsonld-contexts";
import { gleanPrefixes, prefixDeclarations, sparqlExamplesGraph } from "./prefixes";
import { voidDescription, voidGraph } from "./void";

// The wasm-bindgen "web" build normally fetches its .wasm file relative to
// import.meta.url, which doesn't resolve inside a bundled Worker. Wrangler
// already gives us the compiled module directly (as a WebAssembly.Module,
// via its built-in *.wasm import support), so we hand it to initSync and
// skip that fetch entirely.
initSync({ module: wasmModule });

// Every RDF format Oxigraph parses, as listed in src/formats.json (which
// scripts/new-worker.mjs reads too). Most .owl files are RDF/XML; the rarer
// OWL/XML syntax (application/owl+xml) isn't RDF, and Oxigraph can't read it.
export const DATA_FORMATS = formats.map((format) => format.mediaType);
export const TURTLE = "text/turtle";
export const JSON_LD = "application/ld+json";

const FORMATS_BY_EXTENSION = new Map(
  formats.flatMap((format) => format.extensions.map((extension) => [extension, format.mediaType])),
);

// For a URL whose format isn't known up front: every format, in the order of
// src/formats.json, each slightly less preferred than the one before.
const ANY_FORMAT_ACCEPT = [
  ...DATA_FORMATS.map((type, i) => (i === 0 ? type : `${type};q=${(1 - i / 10).toFixed(1)}`)),
  "*/*;q=0.1",
].join(", ");

export interface DataSource {
  url: string;
  // One of DATA_FORMATS. Defaults to the format matching the URL's file
  // extension, or failing that, the response's Content-Type.
  format?: string;
  // Accept header sent when fetching `url`. Defaults to asking for the
  // format, while still accepting anything, so a content-negotiating server
  // picks the right serialization and a plain static host never answers 406.
  accept?: string;
}

let cached:
  | {
      key: string;
      store: Promise<Store>;
      // A revalidation of the data file in progress, shared by the requests
      // that arrive meanwhile.
      checking?: Promise<Store>;
      // After a failed revalidation, no new attempt before this time.
      retryAt?: number;
    }
  | undefined;

// How long to keep serving the copy in memory after a revalidation of the
// data file failed, before trying again.
const RETRY_AFTER_MS = 60_000;

// The data file's response headers that say how long it stays fresh, and
// how to ask whether it changed.
const CACHE_HEADERS = ["cache-control", "expires", "date", "age", "etag", "last-modified"];

interface DataFreshness {
  // When the data last changed: the data file's Last-Modified, or when it
  // was fetched if the server didn't say.
  lastModified: Date;
  // Until when the data file's server lets caches reuse it without asking,
  // if it said. After that, the data file is revalidated.
  expires?: Date;
  // The data file's CACHE_HEADERS, as last received.
  headers: Headers;
}

const freshness = new WeakMap<Store, DataFreshness>();

export function lastModified(store: Store): Date | undefined {
  return freshness.get(store)?.lastModified;
}

export function expires(store: Store): Date | undefined {
  return freshness.get(store)?.expires;
}

// When a response fetched at `fetchedAt` stops being fresh, by its
// Cache-Control max-age (less the Age it already had in caches on the way),
// or else its Expires counted from its Date. A response that may not be
// reused without asking (no-store, no-cache) is stale at once. Undefined
// when it says nothing: such data is kept for the life of the isolate.
function freshUntil(headers: Headers, fetchedAt: Date): Date | undefined {
  const cacheControl = headers.get("Cache-Control")?.toLowerCase() ?? "";
  if (/\b(no-store|no-cache)\b/.test(cacheControl)) {
    return fetchedAt;
  }
  const maxAge = cacheControl.match(/(?:^|[,\s])max-age\s*=\s*"?(\d+)/)?.[1];
  if (maxAge !== undefined) {
    const age = Number.parseInt(headers.get("Age") ?? "0", 10) || 0;
    return new Date(fetchedAt.getTime() + (Number(maxAge) - age) * 1000);
  }
  const expiresAt = Date.parse(headers.get("Expires") ?? "");
  if (!Number.isNaN(expiresAt)) {
    const date = Date.parse(headers.get("Date") ?? "");
    return new Date(fetchedAt.getTime() + expiresAt - (Number.isNaN(date) ? fetchedAt.getTime() : date));
  }
  return undefined;
}

function cacheHeaders(headers: Headers): Headers {
  const kept = new Headers();
  for (const name of CACHE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) {
      kept.set(name, value);
    }
  }
  return kept;
}

function isStale(store: Store): boolean {
  const until = freshness.get(store)?.expires;
  return until !== undefined && until.getTime() <= Date.now();
}

// Loads the configured data file into an in-memory Store once per Worker
// isolate, then reuses it for every subsequent request that isolate handles.
// Once the data file's cache lifetime runs out, the next request asks its
// server whether it changed, with If-None-Match and If-Modified-Since: a 304
// keeps the store and renews its lifetime; new data replaces it. If asking
// fails, the store stays in use, and the next attempt is a minute later.
// With an `endpointUrl` (the endpoint's public URL), the prefixes the file
// declares are added too, and unless `describeVoid` is false, a VoID
// description of the data; see src/prefixes.ts and src/void.ts.
export function getStore(
  source: DataSource,
  endpointUrl?: string,
  { describeVoid = true }: { describeVoid?: boolean } = {},
): Promise<Store> {
  // A Worker's vars are fixed for the life of an isolate, so in practice
  // this key never changes; it keeps the cache honest if it ever does.
  // endpointUrl is left out: without PUBLIC_ENDPOINT_URL it comes from the
  // request, and an endpoint reachable at two hostnames shouldn't reload
  // its data on every switch between them.
  const key = JSON.stringify([source.url, source.format, source.accept, describeVoid]);
  if (cached?.key !== key) {
    const store = loadStore(source, endpointUrl, describeVoid).catch((error: unknown) => {
      // Don't cache a failed load: a transient fetch error shouldn't
      // permanently break every future request on this isolate.
      if (cached?.store === store) {
        cached = undefined;
      }
      throw error;
    });
    cached = { key, store };
    return store;
  }

  const entry = cached;
  entry.checking ??= entry.store
    .then(async (store) => {
      if (!isStale(store) || Date.now() < (entry.retryAt ?? 0)) {
        return store;
      }
      try {
        const current = await loadStore(source, endpointUrl, describeVoid, store);
        entry.store = Promise.resolve(current);
        return current;
      } catch {
        entry.retryAt = Date.now() + RETRY_AFTER_MS;
        return store;
      }
    })
    .finally(() => {
      entry.checking = undefined;
    });
  return entry.checking;
}

// The format a URL's file extension implies, looking through a trailing
// .gz: data.ttl and data.ttl.gz are both Turtle.
export function formatFromUrl(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  const extension = path.replace(/\.gz$/, "").match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? FORMATS_BY_EXTENSION.get(extension) : undefined;
}

// With a `previous` store, asks the data file's server whether it changed
// since, and returns that same store, with its lifetime renewed, if not.
async function loadStore(
  { url, format, accept }: DataSource,
  endpointUrl?: string,
  describeVoid = true,
  previous?: Store,
): Promise<Store> {
  if (format !== undefined && !DATA_FORMATS.includes(format)) {
    throw new Error(
      `Unsupported DATA_FORMAT ${JSON.stringify(format)}; expected one of ${DATA_FORMATS.join(", ")}`,
    );
  }
  const expected = format ?? formatFromUrl(url);
  const defaultAccept = expected ? `${expected}, */*;q=0.1` : ANY_FORMAT_ACCEPT;

  const headers = new Headers({ Accept: accept ?? defaultAccept });
  const known = previous && freshness.get(previous);
  if (known) {
    const etag = known.headers.get("ETag");
    const modified = known.headers.get("Last-Modified");
    if (etag) headers.set("If-None-Match", etag);
    if (modified) headers.set("If-Modified-Since", modified);
  }

  const fetchedAt = new Date();
  const response = await fetch(url, { headers });
  if (previous && known && response.status === 304) {
    // Unchanged. The 304's headers update the ones received before (RFC
    // 9111, section 4.3.4), and with them the store's lifetime.
    await response.body?.cancel();
    const updated = new Headers(known.headers);
    updated.delete("Age");
    for (const [name, value] of cacheHeaders(response.headers)) {
      updated.set(name, value);
    }
    freshness.set(previous, {
      ...known,
      expires: freshUntil(updated, fetchedAt),
      headers: updated,
    });
    return previous;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch RDF data from ${url}: ${response.status} ${response.statusText}`);
  }

  // Only an extensionless URL (typically a content-negotiated one) is left
  // to the server's Content-Type.
  const served = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  const resolved = expected ?? (served && DATA_FORMATS.includes(served) ? served : undefined);
  if (!resolved) {
    throw new Error(
      `Can't tell the RDF format of ${url}: no known RDF file extension, and it was served as ` +
        `${served ?? "no content type"}. Set DATA_FORMAT to one of ${DATA_FORMATS.join(", ")}`,
    );
  }

  let data = await readText(response);
  if (resolved === JSON_LD) {
    data = JSON.stringify(await inlineRemoteContexts(JSON.parse(data), url));
  }

  const store = new Store();
  const modified = Date.parse(response.headers.get("Last-Modified") ?? "");
  freshness.set(store, {
    lastModified: Number.isNaN(modified) ? fetchedAt : new Date(modified),
    expires: freshUntil(response.headers, fetchedAt),
    headers: cacheHeaders(response.headers),
  });
  store.load(data, { format: resolved, base_iri: url });
  if (endpointUrl) {
    // Described before anything else is added, so it covers only the data.
    const description = describeVoid ? voidDescription(store, voidGraph(endpointUrl)) : [];
    const prefixes = gleanPrefixes(data, resolved, url);
    for (const metadata of [
      ...description,
      ...prefixDeclarations(prefixes, sparqlExamplesGraph(endpointUrl)),
    ]) {
      store.add(metadata);
    }
  }
  return store;
}

// fetch() already undoes `Content-Encoding: gzip`. This handles the other
// case: a file that is itself gzipped (data.ttl.gz), served as-is. No
// document in any of these text formats can start with gzip's magic bytes,
// so sniffing them is safe whatever the Content-Type says.
async function readText(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const decompressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(decompressed).text();
  }
  return new TextDecoder().decode(bytes);
}
