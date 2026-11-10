import { initSync, Store } from "oxigraph/web.js";
import wasmModule from "oxigraph/web_bg.wasm";
import { inlineRemoteContexts } from "./jsonld-contexts";

// The wasm-bindgen "web" build normally fetches its .wasm file relative to
// import.meta.url, which doesn't resolve inside a bundled Worker. Wrangler
// already gives us the compiled module directly (as a WebAssembly.Module,
// via its built-in *.wasm import support), so we hand it to initSync and
// skip that fetch entirely.
initSync({ module: wasmModule });

export const TURTLE = "text/turtle";
export const JSON_LD = "application/ld+json";
export const DATA_FORMATS = [TURTLE, JSON_LD];

const FORMATS_BY_EXTENSION: Record<string, string> = {
  ttl: TURTLE,
  jsonld: JSON_LD,
  json: JSON_LD,
};

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

let cached: { key: string; store: Promise<Store> } | undefined;

// Loads the configured data file into an in-memory Store once per Worker
// isolate, then reuses it for every subsequent request that isolate handles.
export function getStore(source: DataSource): Promise<Store> {
  // A Worker's vars are fixed for the life of an isolate, so in practice
  // this key never changes; it keeps the cache honest if it ever does.
  const key = JSON.stringify([source.url, source.format, source.accept]);
  if (cached?.key !== key) {
    const store = loadStore(source).catch((error: unknown) => {
      // Don't cache a failed load: a transient fetch error shouldn't
      // permanently break every future request on this isolate.
      if (cached?.store === store) {
        cached = undefined;
      }
      throw error;
    });
    cached = { key, store };
  }
  return cached.store;
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
  return extension ? FORMATS_BY_EXTENSION[extension] : undefined;
}

async function loadStore({ url, format, accept }: DataSource): Promise<Store> {
  if (format !== undefined && !DATA_FORMATS.includes(format)) {
    throw new Error(
      `Unsupported DATA_FORMAT ${JSON.stringify(format)}; expected one of ${DATA_FORMATS.join(", ")}`,
    );
  }
  const expected = format ?? formatFromUrl(url);
  const defaultAccept = expected
    ? `${expected}, */*;q=0.1`
    : `${TURTLE}, ${JSON_LD};q=0.9, */*;q=0.1`;

  const response = await fetch(url, { headers: { Accept: accept ?? defaultAccept } });
  if (!response.ok) {
    throw new Error(`Failed to fetch RDF data from ${url}: ${response.status} ${response.statusText}`);
  }

  // Only an extensionless URL (typically a content-negotiated one) is left
  // to the server's Content-Type.
  const served = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  const resolved = expected ?? (served && DATA_FORMATS.includes(served) ? served : undefined);
  if (!resolved) {
    throw new Error(
      `Can't tell the RDF format of ${url}: no .ttl/.jsonld/.json extension, and it was served as ` +
        `${served ?? "no content type"}. Set DATA_FORMAT to one of ${DATA_FORMATS.join(", ")}`,
    );
  }

  let data = await readText(response);
  if (resolved === JSON_LD) {
    data = JSON.stringify(await inlineRemoteContexts(JSON.parse(data), url));
  }

  const store = new Store();
  store.load(data, { format: resolved, base_iri: url });
  return store;
}

// fetch() already undoes `Content-Encoding: gzip`. This handles the other
// case: a file that is itself gzipped (data.ttl.gz), served as-is. No Turtle
// or JSON document can start with gzip's magic bytes, so sniffing them is
// safe whatever the Content-Type says.
async function readText(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const decompressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(decompressed).text();
  }
  return new TextDecoder().decode(bytes);
}
