import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { findAlternateLink, inlineRemoteContexts } from "../src/jsonld-contexts";

// A context served from a data: URL, so the end-to-end test exercises the
// real fetch() path for remote contexts without any network access.
const CONTEXT = { "@context": { name: "https://schema.org/name", knows: { "@id": "https://schema.org/knows", "@type": "@id" } } };
const CONTEXT_URL = `data:application/ld+json,${encodeURIComponent(JSON.stringify(CONTEXT))}`;

const DOCUMENT = {
  "@context": CONTEXT_URL,
  "@graph": [
    { "@id": "https://example.org/alice", name: "Alice", knows: "https://example.org/bob" },
    { "@id": "https://example.org/bob", name: "Bob" },
  ],
};

const TEST_ENV = {
  DATA_URL: `data:application/ld+json,${encodeURIComponent(JSON.stringify(DOCUMENT))}`,
  DATA_FORMAT: "application/ld+json",
} as unknown as Env;

async function query(sparql: string) {
  const request = new Request<unknown, IncomingRequestCfProperties>(
    `https://example.com/sparql?query=${encodeURIComponent(sparql)}`,
  );
  const ctx = createExecutionContext();
  const response = await worker.fetch!(request, TEST_ENV, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("SPARQL worker over JSON-LD", () => {
  it("loads a JSON-LD document whose @context is remote", async () => {
    const response = await query(
      "SELECT ?name WHERE { <https://example.org/alice> <https://schema.org/knows> ?friend . ?friend <https://schema.org/name> ?name }",
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ results: { bindings: { name: { value: string } }[] } }>();
    expect(body.results.bindings.map((b) => b.name.value)).toEqual(["Bob"]);
  });
});

// A fake fetch serving fixed responses by URL, recording what was asked for.
function fakeFetch(routes: Record<string, () => Response>) {
  const requested: string[] = [];
  const fetchFn = async (url: string) => {
    requested.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  };
  return { fetchFn, requested };
}

const jsonLd = (body: unknown) => () =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/ld+json" } });

describe("inlineRemoteContexts", () => {
  it("replaces a remote @context with its contents and fetches it once", async () => {
    const { fetchFn, requested } = fakeFetch({
      "https://ctx.example/c": jsonLd({ "@context": { name: "https://schema.org/name" } }),
    });
    const document = [
      { "@context": "https://ctx.example/c", name: "A" },
      { "@context": "https://ctx.example/c", name: "B" },
    ];

    const result = await inlineRemoteContexts(document, "https://data.example/d.jsonld", fetchFn);

    expect(result).toEqual([
      { "@context": { name: "https://schema.org/name" }, name: "A" },
      { "@context": { name: "https://schema.org/name" }, name: "B" },
    ]);
    expect(requested).toEqual(["https://ctx.example/c"]);
  });

  it("follows a Link rel=alternate header, as schema.org requires", async () => {
    const { fetchFn } = fakeFetch({
      "https://schema.example/": () =>
        new Response("<html></html>", {
          headers: {
            "Content-Type": "text/html",
            Link: '</docs/context.jsonld>; rel="alternate"; type="application/ld+json"',
          },
        }),
      "https://schema.example/docs/context.jsonld": jsonLd({ "@context": { "@vocab": "https://schema.example/" } }),
    });

    const result = await inlineRemoteContexts(
      { "@context": "https://schema.example/", name: "A" },
      "https://data.example/d.jsonld",
      fetchFn,
    );

    expect(result).toEqual({ "@context": { "@vocab": "https://schema.example/" }, name: "A" });
  });

  it("resolves relative context URLs, arrays, @import and scoped contexts", async () => {
    const { fetchFn } = fakeFetch({
      "https://data.example/ctx/base": jsonLd({ "@context": [{ a: "https://ex/a" }, "other"] }),
      "https://data.example/ctx/other": jsonLd({ "@context": { b: "https://ex/b" } }),
      "https://data.example/ctx/imported": jsonLd({ "@context": { c: "https://ex/c", d: "https://ex/old-d" } }),
    });
    const document = {
      "@context": [
        "ctx/base",
        { "@import": "ctx/imported", d: "https://ex/d", e: { "@id": "https://ex/e", "@context": "ctx/other" } },
      ],
    };

    const result = await inlineRemoteContexts(document, "https://data.example/d.jsonld", fetchFn);

    expect(result).toEqual({
      "@context": [
        { a: "https://ex/a" },
        { b: "https://ex/b" },
        { c: "https://ex/c", d: "https://ex/d", e: { "@id": "https://ex/e", "@context": { b: "https://ex/b" } } },
      ],
    });
  });

  it("leaves @json literal values alone", async () => {
    const { fetchFn, requested } = fakeFetch({});
    const document = { "https://ex/p": { "@value": { "@context": "https://not.fetched/" }, "@type": "@json" } };

    expect(await inlineRemoteContexts(document, "https://data.example/d.jsonld", fetchFn)).toEqual(document);
    expect(requested).toEqual([]);
  });

  it("rejects a context that includes itself", async () => {
    const { fetchFn } = fakeFetch({
      "https://ctx.example/a": jsonLd({ "@context": "https://ctx.example/b" }),
      "https://ctx.example/b": jsonLd({ "@context": ["https://ctx.example/a"] }),
    });

    await expect(
      inlineRemoteContexts({ "@context": "https://ctx.example/a" }, "https://data.example/d.jsonld", fetchFn),
    ).rejects.toThrow("recursively includes itself");
  });

  it("reports a context that isn't served as JSON", async () => {
    const { fetchFn } = fakeFetch({
      "https://ctx.example/html": () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
    });

    await expect(
      inlineRemoteContexts({ "@context": "https://ctx.example/html" }, "https://data.example/d.jsonld", fetchFn),
    ).rejects.toThrow("not JSON");
  });
});

describe("findAlternateLink", () => {
  it("picks the JSON-LD alternate among several links", () => {
    expect(
      findAlternateLink(
        '<https://a/next>; rel="next", </ctx.jsonld>; rel="alternate"; type="application/ld+json"',
      ),
    ).toBe("/ctx.jsonld");
  });

  it("ignores alternates of other types", () => {
    expect(findAlternateLink('</feed.xml>; rel="alternate"; type="application/rss+xml"')).toBeUndefined();
  });
});
