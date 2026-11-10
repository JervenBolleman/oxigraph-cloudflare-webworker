import { getStore } from "./store";
import { negotiateFormat } from "./content-negotiation";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

const handler: ExportedHandler<Env> = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/sparql") {
      return new Response("Not found. Try /sparql?query=...\n", {
        status: 404,
        headers: CORS_HEADERS,
      });
    }

    const query = await extractQuery(request, url);
    if (query === undefined) {
      return new Response(
        "Missing SPARQL query. Pass ?query=... or POST a SPARQL query body.\n",
        { status: 400, headers: CORS_HEADERS },
      );
    }

    let store;
    try {
      store = await getStore({
        url: env.DATA_URL,
        format: env.DATA_FORMAT || undefined,
        accept: env.DATA_ACCEPT || undefined,
      });
    } catch (error) {
      return new Response(`Failed to load the RDF dataset: ${message(error)}\n`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }

    const resultsFormat = negotiateFormat(request.headers.get("Accept"));
    let result;
    try {
      result = store.query(query, { results_format: resultsFormat });
    } catch (error) {
      return new Response(`Invalid SPARQL query: ${message(error)}\n`, {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    if (typeof result !== "string") {
      // Only happens if results_format was ignored, which shouldn't occur
      // for the formats negotiateFormat() ever returns.
      return new Response("Could not serialize query results.\n", {
        status: 500,
        headers: CORS_HEADERS,
      });
    }

    return new Response(result, {
      headers: { ...CORS_HEADERS, "Content-Type": resultsFormat },
    });
  },
};

export default handler;

async function extractQuery(request: Request, url: URL): Promise<string | undefined> {
  const fromQueryString = url.searchParams.get("query");
  if (fromQueryString !== null) {
    return fromQueryString;
  }

  if (request.method !== "POST") {
    return undefined;
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/sparql-query")) {
    // Not request.text(): workerd only recognises a fixed allowlist of
    // "text-like" content types there and warns on anything else, even
    // though application/sparql-query bodies are plain UTF-8 text.
    return new TextDecoder().decode(await request.arrayBuffer());
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await request.text();
    return new URLSearchParams(body).get("query") ?? undefined;
  }
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
