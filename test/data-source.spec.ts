import { afterEach, describe, expect, it, vi } from "vitest";
import { formatFromUrl, getStore, JSON_LD, RDF_XML, TURTLE } from "../src/store";

const TURTLE_DATA = '<https://example.org/alice> <https://schema.org/name> "Alice" .\n';
const JSON_LD_DATA = JSON.stringify({ "@id": "https://example.org/alice", "https://schema.org/name": "Alice" });
// The shape OWL tools such as Protégé write: DTD entities and xml:base.
const RDF_XML_DATA = `<?xml version="1.0"?>
<!DOCTYPE rdf:RDF [ <!ENTITY ex "https://example.org/" > ]>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
    xmlns:schema="https://schema.org/" xml:base="https://example.org/">
  <rdf:Description rdf:about="&ex;alice"><schema:name>Alice</schema:name></rdf:Description>
</rdf:RDF>
`;

// Stubs the global fetch with one fixed response, recording the requests.
function serve(body: BodyInit, headers: Record<string, string> = {}) {
  const requests: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(body, { headers });
  });
  return requests;
}

async function names(url: string, format?: string, accept?: string): Promise<string[]> {
  const store = await getStore({ url, format, accept });
  const rows = store.query("SELECT ?name WHERE { ?s <https://schema.org/name> ?name }") as Map<
    string,
    { value: string }
  >[];
  return rows.map((row) => row.get("name")!.value);
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatFromUrl", () => {
  it.each([
    ["https://x.example/data.ttl", TURTLE],
    ["https://x.example/data.jsonld", JSON_LD],
    ["https://x.example/data.json", JSON_LD],
    ["https://x.example/data.ttl.gz", TURTLE],
    ["https://x.example/DATA.JSONLD.GZ", JSON_LD],
    ["https://x.example/data.ttl?version=2#top", TURTLE],
    ["https://x.example/data.rdf", RDF_XML],
    ["https://x.example/onto.owl", RDF_XML],
    ["https://x.example/onto.owl.gz", RDF_XML],
    ["https://x.example/data", undefined],
    ["https://x.example/data.gz", undefined],
    ["https://x.example/data.csv", undefined],
  ])("%s -> %s", (url, format) => {
    expect(formatFromUrl(url)).toBe(format);
  });
});

describe("loading the data file", () => {
  it("goes by the file extension and asks for that format", async () => {
    const requests = serve(JSON_LD_DATA, { "Content-Type": "text/plain" });

    expect(await names("https://x.example/a.jsonld")).toEqual(["Alice"]);
    expect(requests[0].headers.get("Accept")).toBe("application/ld+json, */*;q=0.1");
  });

  it("lets DATA_FORMAT override the extension", async () => {
    const requests = serve(TURTLE_DATA);

    expect(await names("https://x.example/b.txt", TURTLE)).toEqual(["Alice"]);
    expect(requests[0].headers.get("Accept")).toBe("text/turtle, */*;q=0.1");
  });

  it("lets DATA_ACCEPT override the Accept header", async () => {
    const requests = serve(TURTLE_DATA);

    await names("https://x.example/c.ttl", undefined, "text/turtle;q=1, application/n-triples;q=0.5");
    expect(requests[0].headers.get("Accept")).toBe("text/turtle;q=1, application/n-triples;q=0.5");
  });

  it("falls back to the Content-Type for a URL without an extension", async () => {
    const requests = serve(JSON_LD_DATA, { "Content-Type": "application/ld+json; charset=utf-8" });

    expect(await names("https://x.example/negotiated")).toEqual(["Alice"]);
    expect(requests[0].headers.get("Accept")).toBe(
      "text/turtle, application/ld+json;q=0.9, application/rdf+xml;q=0.8, */*;q=0.1",
    );
  });

  it("reads an .owl file as RDF/XML and asks for RDF/XML", async () => {
    const requests = serve(RDF_XML_DATA, { "Content-Type": "application/xml" });

    expect(await names("https://x.example/onto.owl")).toEqual(["Alice"]);
    expect(requests[0].headers.get("Accept")).toBe("application/rdf+xml, */*;q=0.1");
  });

  it("decompresses a gzipped .rdf file served as-is", async () => {
    serve(await gzip(RDF_XML_DATA), { "Content-Type": "application/gzip" });

    expect(await names("https://x.example/g.rdf.gz")).toEqual(["Alice"]);
  });

  it("uses an application/rdf+xml Content-Type for a URL without an extension", async () => {
    serve(RDF_XML_DATA, { "Content-Type": "application/rdf+xml" });

    expect(await names("https://x.example/negotiated-xml")).toEqual(["Alice"]);
  });

  it("explains how to fix a format it can't determine", async () => {
    serve(TURTLE_DATA, { "Content-Type": "text/plain" });

    await expect(getStore({ url: "https://x.example/unknown" })).rejects.toThrow("Set DATA_FORMAT");
  });

  it("rejects an unsupported DATA_FORMAT", async () => {
    serve(TURTLE_DATA);

    await expect(getStore({ url: "https://x.example/d.ttl", format: "text/csv" })).rejects.toThrow(
      "Unsupported DATA_FORMAT",
    );
  });

  it("decompresses a gzipped Turtle file served as-is", async () => {
    serve(await gzip(TURTLE_DATA), { "Content-Type": "application/gzip" });

    expect(await names("https://x.example/e.ttl.gz")).toEqual(["Alice"]);
  });

  it("decompresses a gzipped JSON-LD file served as-is", async () => {
    serve(await gzip(JSON_LD_DATA), { "Content-Type": "application/gzip" });

    expect(await names("https://x.example/f.jsonld.gz")).toEqual(["Alice"]);
  });
});
