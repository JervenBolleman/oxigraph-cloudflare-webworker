import { namedNode } from "oxigraph/web.js";
import { expires, getStore, lastModified } from "./store";
import { negotiateFormat } from "./content-negotiation";
import { acceptsHtml, editorPage } from "./editor-page";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

// The endpoint's one canonical path. Its slashless form redirects here.
const ENDPOINT_PATH = "/sparql/";

// Responses from the endpoint depend on the Accept header: it picks the
// results format, and whether a browser gets the editor page.
const ENDPOINT_HEADERS = { ...CORS_HEADERS, Vary: "Accept" };


// Disallow is a prefix match, so this covers /sparql/ too.
const ROBOTS_TXT = "User-agent: *\nDisallow: /sparql\n";

const handler: ExportedHandler<Env> = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const endpointUrl = env.PUBLIC_ENDPOINT_URL || `${url.origin}${ENDPOINT_PATH}`;
    if (url.pathname === "/robots.txt") {
      // Every query is answered from scratch, so a crawler following
      // links into /sparql would only burn CPU time on the endpoint.
      return new Response(ROBOTS_TXT, {
        headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname === "/") {
      // The home page is always the editor, whatever the Accept header.
      return editorResponse(endpointUrl, env);
    }
    if (url.pathname === "/sparql") {
      // 308, not 301: a client that follows it repeats a POST with its
      // body, rather than turning it into a GET without one. The query
      // string comes along. CORS headers let browsers follow it too.
      return new Response(null, {
        status: 308,
        headers: { ...CORS_HEADERS, Location: `${ENDPOINT_PATH}${url.search}` },
      });
    }
    if (url.pathname !== ENDPOINT_PATH) {
      return new Response(`Not found. Try ${ENDPOINT_PATH}?query=...\n`, {
        status: 404,
        headers: CORS_HEADERS,
      });
    }

    const { query, params } = await extractQuery(request, url);
    if (query === undefined && acceptsHtml(request.headers.get("Accept"))) {
      // A browser visiting the endpoint: give it an editor for this
      // endpoint instead of an error.
      const response = editorResponse(endpointUrl, env);
      response.headers.set("Vary", "Accept");
      return response;
    }
    if (query === undefined) {
      return new Response(
        "Missing SPARQL query. Pass ?query=... or POST a SPARQL query body.\n",
        { status: 400, headers: ENDPOINT_HEADERS },
      );
    }

    let store;
    try {
      store = await getStore(
        {
          url: env.DATA_URL,
          format: env.DATA_FORMAT || undefined,
          accept: env.DATA_ACCEPT || undefined,
        },
        endpointUrl,
        { describeVoid: env.GENERATE_VOID !== "false" },
      );
    } catch (error) {
      return new Response(`Failed to load the RDF dataset: ${message(error)}\n`, {
        status: 502,
        headers: ENDPOINT_HEADERS,
      });
    }

    // Results change only when the data or the code does: whichever of the
    // data file's Last-Modified and this version's deployment is later.
    const modified = latest(lastModified(store), deployedAt(env));
    const cacheHeaders = {
      ...ENDPOINT_HEADERS,
      "Cache-Control": cacheControl(expires(store)),
      ...(modified && { "Last-Modified": modified.toUTCString() }),
    };
    if (modified && notModifiedSince(request, modified)) {
      return new Response(null, { status: 304, headers: cacheHeaders });
    }

    let dataset;
    try {
      dataset = protocolDataset(params);
    } catch (error) {
      return new Response(`Invalid default-graph-uri or named-graph-uri: ${message(error)}\n`, {
        status: 400,
        headers: ENDPOINT_HEADERS,
      });
    }

    const resultsFormat = negotiateFormat(request.headers.get("Accept"));
    let result;
    try {
      result = store.query(query, { results_format: resultsFormat, ...dataset });
    } catch (error) {
      return new Response(`Invalid SPARQL query: ${message(error)}\n`, {
        status: 400,
        headers: ENDPOINT_HEADERS,
      });
    }

    if (typeof result !== "string") {
      // Only happens if results_format was ignored, which shouldn't occur
      // for the formats negotiateFormat() ever returns.
      return new Response("Could not serialize query results.\n", {
        status: 500,
        headers: ENDPOINT_HEADERS,
      });
    }

    return new Response(result, {
      headers: { ...cacheHeaders, "Content-Type": resultsFormat },
    });
  },
};

export default handler;

// The query, and the protocol parameters that go with it (such as
// default-graph-uri), from wherever the SPARQL 1.1 Protocol puts them:
// - GET: both in the URL.
// - POST application/sparql-query: the query is the body, the parameters
//   are in the URL.
// - POST application/x-www-form-urlencoded: both in the body.
// A POST's body wins over a ?query= in the URL. A POST without a query in
// its body still falls back to the URL, for clients that POST to a
// GET-style URL.
async function extractQuery(
  request: Request,
  url: URL,
): Promise<{ query?: string; params: URLSearchParams }> {
  if (request.method === "POST") {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/sparql-query")) {
      // Not request.text(): workerd only recognises a fixed allowlist of
      // "text-like" content types there and warns on anything else, even
      // though application/sparql-query bodies are plain UTF-8 text.
      const query = new TextDecoder().decode(await request.arrayBuffer());
      return { query, params: url.searchParams };
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const form = new URLSearchParams(await request.text());
      const query = form.get("query");
      if (query !== null) {
        return { query, params: form };
      }
    }
  }
  return { query: url.searchParams.get("query") ?? undefined, params: url.searchParams };
}

// The RDF dataset named by default-graph-uri and named-graph-uri, as Oxigraph
// query options. When either is given, the dataset is exactly what they
// name (an empty default graph, or no named graphs, for the one left out),
// and it replaces any FROM and FROM NAMED in the query, as the SPARQL 1.1
// Protocol specifies. Without either, the query's own dataset applies.
function protocolDataset(params: URLSearchParams) {
  const defaultGraphs = params.getAll("default-graph-uri");
  const namedGraphs = params.getAll("named-graph-uri");
  if (defaultGraphs.length === 0 && namedGraphs.length === 0) {
    return {};
  }
  return {
    default_graph: defaultGraphs.map((iri) => namedNode(iri)),
    named_graphs: namedGraphs.map((iri) => namedNode(iri)),
  };
}

// Results stay fresh as long as the data file they came from: for what is
// left of its cache lifetime, if its server gave one. Otherwise caches may
// keep results, but must check with If-Modified-Since before reusing them,
// which costs a cheap 304; without that, a cache could guess a lifetime
// from Last-Modified and serve stale results for long.
function cacheControl(dataExpires: Date | undefined): string {
  const seconds = dataExpires ? Math.floor((dataExpires.getTime() - Date.now()) / 1000) : 0;
  return seconds > 0 ? `max-age=${seconds}` : "no-cache";
}

// When this version of the Worker was deployed, from the version_metadata
// binding. Undefined if a config doesn't declare the binding.
function deployedAt(env: Env): Date | undefined {
  const timestamp = Date.parse(env.CF_VERSION_METADATA?.timestamp ?? "");
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}

// The later of the known dates, to whole seconds as HTTP dates have them.
function latest(...dates: (Date | undefined)[]): Date | undefined {
  const times = dates.filter((date) => date !== undefined).map((date) => date.getTime());
  return times.length ? new Date(Math.floor(Math.max(...times) / 1000) * 1000) : undefined;
}

// A conditional GET or HEAD whose copy is still current. Other methods must
// ignore If-Modified-Since (RFC 9110, section 13.1.3).
function notModifiedSince(request: Request, modified: Date): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }
  const since = Date.parse(request.headers.get("If-Modified-Since") ?? "");
  return !Number.isNaN(since) && modified.getTime() <= since;
}

function editorResponse(endpointUrl: string, env: Env): Response {
  return new Response(editorPage(endpointUrl, env.DATA_URL, env.EDITOR_CSS_URL || undefined), {
    headers: { ...CORS_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
