import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const TURTLE = '<https://example.org/alice> <https://schema.org/name> "Alice" .\n';
const QUERY = "ASK { ?s ?p ?o }";

// Serves the data file with the given Last-Modified, if any, and headers.
function serve(lastModified?: string, headers: Record<string, string> = {}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(TURTLE, {
        headers: { ...(lastModified && { "Last-Modified": lastModified }), ...headers },
      }),
  );
}

let loads = 0;

// A fresh data URL per test, so each loads its own store.
async function call(
  init: RequestInit & { deployed?: string; url?: string } = {},
): Promise<Response> {
  const { deployed, url, ...requestInit } = init;
  const env = {
    DATA_URL: `https://data.example/caching-${loads++}.ttl`,
    ...(deployed && { CF_VERSION_METADATA: { id: "v", tag: "", timestamp: deployed } }),
  } as unknown as Env;
  const request = new Request<unknown, IncomingRequestCfProperties>(
    new Request(url ?? `https://example.com/sparql/?query=${encodeURIComponent(QUERY)}`, requestInit),
  );
  const ctx = createExecutionContext();
  const response = await worker.fetch!(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Last-Modified", () => {
  it("is the data file's when that is later than the deployment", async () => {
    serve("Wed, 25 Nov 2026 10:00:00 GMT");
    const response = await call({ deployed: "2026-11-01T08:00:00.000Z" });

    expect(response.headers.get("Last-Modified")).toBe("Wed, 25 Nov 2026 10:00:00 GMT");
  });

  it("is the deployment's when that is later than the data file", async () => {
    serve("Wed, 25 Nov 2026 10:00:00 GMT");
    const response = await call({ deployed: "2026-11-26T09:30:15.789Z" });

    expect(response.headers.get("Last-Modified")).toBe("Thu, 26 Nov 2026 09:30:15 GMT");
  });

  it("falls back to when the data was fetched, without either", async () => {
    serve();
    const before = Math.floor(Date.now() / 1000) * 1000;
    const response = await call();

    const modified = Date.parse(response.headers.get("Last-Modified")!);
    expect(modified).toBeGreaterThanOrEqual(before);
    expect(modified).toBeLessThanOrEqual(Date.now());
  });

});

describe("Cache-Control", () => {
  // The max-age of a response, allowing a second for the test to run.
  async function maxAge(headers: Record<string, string>): Promise<string> {
    serve(undefined, headers);
    return (await call()).headers.get("Cache-Control")!;
  }

  it("is no-cache when the data file's server gives no lifetime, so caches revalidate", async () => {
    expect(await maxAge({})).toBe("no-cache");
  });

  it("passes on the data file's max-age", async () => {
    expect(await maxAge({ "Cache-Control": "public, max-age=3600" })).toMatch(/^max-age=(3600|3599)$/);
  });

  it("passes on only what is left of it, less the Age it had", async () => {
    expect(await maxAge({ "Cache-Control": "max-age=3600", Age: "600" })).toMatch(/^max-age=(3000|2999)$/);
  });

  it("uses Expires, counted from the data file's Date, without a max-age", async () => {
    const date = new Date();
    const headers = {
      Date: date.toUTCString(),
      Expires: new Date(date.getTime() + 7200_000).toUTCString(),
    };
    expect(await maxAge(headers)).toMatch(/^max-age=(7200|7199)$/);
  });

  it("is no-cache when the data file's lifetime is over, or it mustn't be reused", async () => {
    expect(await maxAge({ "Cache-Control": "max-age=60", Age: "120" })).toBe("no-cache");
    expect(await maxAge({ "Cache-Control": "no-store, max-age=3600" })).toBe("no-cache");
    expect(await maxAge({ "Cache-Control": "no-cache" })).toBe("no-cache");
  });

  it("isn't affected by s-maxage, which is for shared caches", async () => {
    expect(await maxAge({ "Cache-Control": "s-maxage=3600" })).toBe("no-cache");
  });
});

describe("If-Modified-Since", () => {
  const DATA = "Wed, 25 Nov 2026 10:00:00 GMT";

  it("gets a 304 without a body when nothing changed since", async () => {
    serve(DATA);
    for (const since of [DATA, "Thu, 26 Nov 2026 00:00:00 GMT"]) {
      const response = await call({ headers: { "If-Modified-Since": since } });

      expect(response.status).toBe(304);
      expect(await response.text()).toBe("");
      expect(response.headers.get("Last-Modified")).toBe(DATA);
      expect(response.headers.get("Vary")).toBe("Accept");
    }
  });

  it("gets the results when the data changed since", async () => {
    serve(DATA);
    const response = await call({ headers: { "If-Modified-Since": "Wed, 25 Nov 2026 09:59:59 GMT" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ head: {}, boolean: true });
  });

  it("gets the results when the deployment is newer than the client's copy", async () => {
    serve(DATA);
    const response = await call({
      deployed: "2026-11-26T09:00:00.000Z",
      headers: { "If-Modified-Since": DATA },
    });

    expect(response.status).toBe(200);
  });

  it("is ignored on a POST, as RFC 9110 requires", async () => {
    serve(DATA);
    const response = await call({
      url: "https://example.com/sparql/",
      method: "POST",
      headers: { "Content-Type": "application/sparql-query", "If-Modified-Since": DATA },
      body: QUERY,
    });

    expect(response.status).toBe(200);
  });

  it("is ignored when it isn't a date", async () => {
    serve(DATA);
    const response = await call({ headers: { "If-Modified-Since": "yesterday" } });

    expect(response.status).toBe(200);
  });
});

describe("Vary: Accept", () => {
  it("is on results, which the Accept header picks the format of", async () => {
    serve();
    const response = await call({ headers: { Accept: "text/csv" } });

    expect(response.headers.get("Content-Type")).toBe("text/csv");
    expect(response.headers.get("Vary")).toBe("Accept");
  });

  it("is on errors from the endpoint", async () => {
    serve();
    for (const url of [
      "https://example.com/sparql/",
      `https://example.com/sparql/?query=${encodeURIComponent("NOT SPARQL")}`,
    ]) {
      const response = await call({ url });

      expect(response.status).toBe(400);
      expect(response.headers.get("Vary")).toBe("Accept");
    }
  });
});
