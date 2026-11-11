import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const TURTLE = `
@prefix schema: <https://schema.org/> .
<https://example.org/alice> schema:name "Alice" .
`;

const TEST_ENV = {
  DATA_URL: `data:text/turtle,${encodeURIComponent(TURTLE)}`,
  DATA_FORMAT: "text/turtle",
} as unknown as Env;

async function callWorker(request: Request): Promise<Response> {
  const incoming = new Request<unknown, IncomingRequestCfProperties>(request);
  const ctx = createExecutionContext();
  const response = await worker.fetch!(incoming, TEST_ENV, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("SPARQL worker", () => {
  it("answers a SELECT query as SPARQL JSON", async () => {
    const query = "SELECT ?name WHERE { ?s <https://schema.org/name> ?name }";
    const response = await callWorker(
      new Request(`https://example.com/sparql?query=${encodeURIComponent(query)}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/sparql-results+json");
    const body = await response.json<{
      results: { bindings: { name: { value: string } }[] };
    }>();
    expect(body.results.bindings).toHaveLength(1);
    expect(body.results.bindings[0].name.value).toBe("Alice");
  });

  it("answers an ASK query", async () => {
    const query = "ASK { ?s ?p ?o }";
    const response = await callWorker(
      new Request(`https://example.com/sparql?query=${encodeURIComponent(query)}`),
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ boolean: boolean }>();
    expect(body.boolean).toBe(true);
  });

  it("accepts a POST body with content type application/sparql-query", async () => {
    // Only the data's own triples: the default graph also holds a copy of
    // the prefix declarations.
    const query = "SELECT (COUNT(*) AS ?count) WHERE { ?s <https://schema.org/name> ?o }";
    const response = await callWorker(
      new Request("https://example.com/sparql", {
        method: "POST",
        headers: { "Content-Type": "application/sparql-query" },
        body: query,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      results: { bindings: { count: { value: string } }[] };
    }>();
    expect(body.results.bindings[0].count.value).toBe("1");
  });

  it("returns Turtle for a CONSTRUCT query when asked", async () => {
    const query = "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }";
    const response = await callWorker(
      new Request(`https://example.com/sparql?query=${encodeURIComponent(query)}`, {
        headers: { Accept: "text/turtle" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/turtle");
    const body = await response.text();
    expect(body).toContain("Alice");
  });

  it("400s on an invalid query", async () => {
    const response = await callWorker(new Request("https://example.com/sparql?query=NOT+SPARQL"));

    expect(response.status).toBe(400);
  });

  it("400s when no query is given", async () => {
    const response = await callWorker(new Request("https://example.com/sparql"));

    expect(response.status).toBe(400);
  });

  it("declares the data's prefixes below the endpoint's own URL", async () => {
    const query =
      "SELECT ?namespace WHERE { GRAPH <https://example.com/sparql/.well-known/sparql-examples/> " +
      '{ ?d <http://www.w3.org/ns/shacl#prefix> "schema" ; <http://www.w3.org/ns/shacl#namespace> ?namespace } }';
    const response = await callWorker(
      new Request(`https://example.com/sparql?query=${encodeURIComponent(query)}`),
    );

    const body = await response.json<{ results: { bindings: { namespace: { value: string } }[] } }>();
    expect(body.results.bindings.map((b) => b.namespace.value)).toEqual(["https://schema.org/"]);
  });

  it("also answers the editor's prefix query, which has no GRAPH clause", async () => {
    const query =
      "SELECT ?namespace WHERE { ?d <http://www.w3.org/ns/shacl#prefix> \"schema\" ; " +
      "<http://www.w3.org/ns/shacl#namespace> ?namespace }";
    const response = await callWorker(
      new Request(`https://example.com/sparql?query=${encodeURIComponent(query)}`),
    );

    const body = await response.json<{ results: { bindings: { namespace: { value: string } }[] } }>();
    expect(body.results.bindings.map((b) => b.namespace.value)).toEqual(["https://schema.org/"]);
  });

  it("keeps to the dataset a query picks with FROM", async () => {
    const query = "SELECT (COUNT(*) AS ?count) FROM <https://example.org/nothing> WHERE { ?s ?p ?o }";
    const response = await callWorker(
      new Request(`https://example.com/sparql?query=${encodeURIComponent(query)}`),
    );

    const body = await response.json<{ results: { bindings: { count: { value: string } }[] } }>();
    expect(body.results.bindings[0].count.value).toBe("0");
  });

  it("asks crawlers to stay out of /sparql", async () => {
    const response = await callWorker(new Request("https://example.com/robots.txt"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("User-agent: *\nDisallow: /sparql\n");
  });

  it("404s on unknown paths", async () => {
    const response = await callWorker(new Request("https://example.com/nope"));

    expect(response.status).toBe(404);
  });
});
