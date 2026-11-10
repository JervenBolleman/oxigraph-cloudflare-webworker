// Oxigraph's JSON-LD parser can't load remote contexts: its JS API has no
// document loader option, so a document using `"@context":
// "https://schema.org/"` fails with "No LoadDocumentCallback has been set".
// We fetch every remote context ourselves and inline it into the document
// before handing it to Oxigraph, which then only ever sees local contexts.

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// A JSON-LD document is arbitrary JSON; we only care about objects, arrays
// and the "@context" members inside them.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const ACCEPT = "application/ld+json, application/json;q=0.9";

// Upper bound on distinct remote contexts one dataset may pull in, so a
// context that (directly or indirectly) references itself, or a hostile
// document, can't make the Worker fetch forever.
const MAX_REMOTE_CONTEXTS = 20;

export async function inlineRemoteContexts(
  document: Json,
  documentUrl: string,
  // Wrapped rather than passed as-is: workerd's fetch throws "Illegal
  // invocation" when called with any `this` other than the global scope.
  fetchFn: Fetch = (input, init) => fetch(input, init),
): Promise<Json> {
  const loader = new ContextLoader(fetchFn);
  return resolveNode(document, documentUrl, loader);
}

class ContextLoader {
  // Keyed by absolute URL, so a context used by many nodes (the usual case)
  // is fetched once per dataset load.
  private readonly cache = new Map<string, Promise<Json>>();

  constructor(private readonly fetchFn: Fetch) {}

  // `chain` holds the remote contexts currently being resolved above this
  // one. A context that (indirectly) includes itself would otherwise wait on
  // its own pending cache entry forever.
  load(url: string, chain: readonly string[]): Promise<Json> {
    if (chain.includes(url)) {
      throw new Error(`JSON-LD context ${url} recursively includes itself`);
    }
    let context = this.cache.get(url);
    if (!context) {
      if (this.cache.size >= MAX_REMOTE_CONTEXTS) {
        throw new Error(
          `More than ${MAX_REMOTE_CONTEXTS} remote JSON-LD contexts referenced; refusing to load ${url}`,
        );
      }
      context = this.fetchContext(url, chain);
      this.cache.set(url, context);
    }
    return context;
  }

  // Returns the value of the remote document's "@context" member, already
  // resolved, so callers can splice it in where the URL was.
  private async fetchContext(url: string, chain: readonly string[]): Promise<Json> {
    const document = await this.fetchJson(url);
    if (document === null || typeof document !== "object" || Array.isArray(document) || !("@context" in document)) {
      throw new Error(`Remote JSON-LD context ${url} has no top-level "@context"`);
    }
    return resolveContext(document["@context"], url, this, [...chain, url]);
  }

  private async fetchJson(url: string, followAlternate = true): Promise<Json> {
    const response = await this.fetchFn(url, { headers: { Accept: ACCEPT } });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch JSON-LD context ${url}: ${response.status} ${response.statusText}`,
      );
    }
    if (isJson(response.headers.get("Content-Type"))) {
      return response.json<Json>();
    }
    // JSON-LD 1.1 remote document retrieval: a non-JSON response (schema.org
    // answers with HTML) may point at the JSON-LD version of itself through
    // a Link: <...>; rel="alternate"; type="application/ld+json" header.
    const alternate = followAlternate ? findAlternateLink(response.headers.get("Link")) : undefined;
    if (alternate) {
      return this.fetchJson(new URL(alternate, response.url || url).href, false);
    }
    throw new Error(
      `JSON-LD context ${url} was served as ${response.headers.get("Content-Type") ?? "no content type"}, not JSON`,
    );
  }
}

// Walks the data itself, resolving every "@context" found on a node object.
async function resolveNode(value: Json, baseUrl: string, loader: ContextLoader): Promise<Json> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveNode(item, baseUrl, loader)));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if ("@value" in value) {
    // A literal. With "@type": "@json" its value is opaque JSON that may
    // legitimately contain an "@context" key, so leave it untouched.
    return value;
  }
  const resolved: { [key: string]: Json } = {};
  for (const [key, child] of Object.entries(value)) {
    resolved[key] =
      key === "@context"
        ? await resolveContext(child, baseUrl, loader, [])
        : await resolveNode(child, baseUrl, loader);
  }
  return resolved;
}

// Resolves one "@context" value: a URL, an inline context object, null, or
// an array of those.
async function resolveContext(
  context: Json,
  baseUrl: string,
  loader: ContextLoader,
  chain: readonly string[],
): Promise<Json> {
  if (typeof context === "string") {
    // Relative context references resolve against the document (or remote
    // context) they appear in.
    return loader.load(new URL(context, baseUrl).href, chain);
  }
  if (Array.isArray(context)) {
    const resolved = await Promise.all(context.map((item) => resolveContext(item, baseUrl, loader, chain)));
    // A remote context may itself be an array; an "@context" array can't
    // nest, so splice its entries in place.
    return resolved.flat();
  }
  if (context === null || typeof context !== "object") {
    return context;
  }

  let definitions: { [key: string]: Json } = context;
  const imported = context["@import"];
  if (typeof imported === "string") {
    // JSON-LD 1.1 "@import": the imported context's definitions apply first,
    // and this context's own definitions override them.
    const importedContext = await loader.load(new URL(imported, baseUrl).href, chain);
    if (importedContext === null || typeof importedContext !== "object" || Array.isArray(importedContext)) {
      throw new Error(`"@import" of ${imported} must refer to a single context object`);
    }
    const { "@import": _, ...own } = context;
    definitions = { ...importedContext, ...own };
  }

  // Term definitions can carry their own scoped "@context", which may also
  // be remote.
  const resolved: { [key: string]: Json } = {};
  for (const [term, definition] of Object.entries(definitions)) {
    if (definition !== null && typeof definition === "object" && !Array.isArray(definition) && "@context" in definition) {
      resolved[term] = {
        ...definition,
        "@context": await resolveContext(definition["@context"], baseUrl, loader, chain),
      };
    } else {
      resolved[term] = definition;
    }
  }
  return resolved;
}

function isJson(contentType: string | null): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

// Picks the target of a `rel="alternate"; type="application/ld+json"` entry
// out of an HTTP Link header.
export function findAlternateLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }
  for (const match of linkHeader.matchAll(/<([^>]*)>((?:\s*;\s*[^;,]+)*)/g)) {
    const params = new Map<string, string>();
    for (const param of match[2].split(";")) {
      const [name, ...rest] = param.split("=");
      if (name?.trim() && rest.length > 0) {
        params.set(name.trim().toLowerCase(), rest.join("=").trim().replace(/^"|"$/g, ""));
      }
    }
    const rels = params.get("rel")?.toLowerCase().split(/\s+/) ?? [];
    if (rels.includes("alternate") && params.get("type")?.toLowerCase() === "application/ld+json") {
      return match[1];
    }
  }
  return undefined;
}
