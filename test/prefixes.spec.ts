import { afterEach, describe, expect, it, vi } from "vitest";
import { gleanPrefixes, sparqlExamplesGraph } from "../src/prefixes";
import { getStore } from "../src/store";

const TURTLE = `@prefix schema: <https://schema.org/> .
PREFIX ex: <https://example.org/>
  prefix rel: <vocab#>
@prefix : <https://example.org/default#> .
<https://example.org/alice> schema:name "Not @prefix fake: <https://fake.example/> ." .
`;

const RDF_XML = `<?xml version="1.0"?>
<!DOCTYPE rdf:RDF [ <!ENTITY ex "https://example.org/" > ]>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
    xmlns:schema='https://schema.org/' xmlns:ent="&ex;"
    xml:base="https://example.org/">
  <rdf:Description rdf:about="&ex;alice"><schema:name>Alice</schema:name></rdf:Description>
</rdf:RDF>
`;

const ENDPOINT = "https://sparql.example.org/sparql";
const GRAPH = "https://sparql.example.org/sparql/.well-known/sparql-examples/";

// The query the SIB SPARQL editor sends for an endpoint's prefixes.
const EDITOR_PREFIX_QUERY = `PREFIX sh: <http://www.w3.org/ns/shacl#>
SELECT DISTINCT ?prefix ?namespace
WHERE { [] sh:namespace ?namespace ; sh:prefix ?prefix }
ORDER BY ?prefix`;

function serve(body: string) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body));
}

function select(store: Awaited<ReturnType<typeof getStore>>, query: string): Record<string, string>[] {
  const rows = store.query(query) as Map<string, { value: string }>[];
  return rows.map((row) => Object.fromEntries([...row].map(([key, term]) => [key, term.value])));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gleanPrefixes", () => {
  it("reads both Turtle prefix styles, resolving relative namespaces", () => {
    expect(gleanPrefixes(TURTLE, "text/turtle", "https://data.example/dir/a.ttl")).toEqual(
      new Map([
        ["schema", "https://schema.org/"],
        ["ex", "https://example.org/"],
        ["rel", "https://data.example/dir/vocab#"],
      ]),
    );
  });

  it("reads TriG and N3 like Turtle", () => {
    for (const format of ["application/trig", "text/n3"]) {
      expect(gleanPrefixes(TURTLE, format, "https://x.example/").get("schema")).toBe("https://schema.org/");
    }
  });

  it("reads RDF/XML namespace declarations, skipping entity references", () => {
    expect(gleanPrefixes(RDF_XML, "application/rdf+xml", "https://x.example/")).toEqual(
      new Map([
        ["rdf", "http://www.w3.org/1999/02/22-rdf-syntax-ns#"],
        ["schema", "https://schema.org/"],
      ]),
    );
  });

  it("finds nothing in formats without prefix declarations", () => {
    expect(gleanPrefixes(TURTLE, "application/n-triples", "https://x.example/").size).toBe(0);
  });
});

describe("sparqlExamplesGraph", () => {
  it("adds the path below the endpoint URL", () => {
    expect(sparqlExamplesGraph(ENDPOINT)).toBe(GRAPH);
    expect(sparqlExamplesGraph(`${ENDPOINT}/`)).toBe(GRAPH);
  });
});

describe("prefix declarations in the store", () => {
  it("are in the sparql-examples graph, with a copy in the default graph", async () => {
    serve(TURTLE);
    const store = await getStore({ url: "https://x.example/both-graphs.ttl" }, ENDPOINT);

    expect(store.query("ASK { ?s <http://www.w3.org/ns/shacl#prefix> ?p }")).toBe(true);
    expect(store.query(`ASK { GRAPH <${GRAPH}> { ?s <http://www.w3.org/ns/shacl#prefix> ?p } }`)).toBe(true);
  });

  it("are what the editor's prefix query finds", async () => {
    serve(TURTLE);
    const store = await getStore({ url: "https://x.example/editor.ttl" }, ENDPOINT);

    expect(select(store, EDITOR_PREFIX_QUERY)).toEqual([
      { prefix: "ex", namespace: "https://example.org/" },
      { prefix: "rel", namespace: "https://x.example/vocab#" },
      { prefix: "schema", namespace: "https://schema.org/" },
    ]);
  });

  it("are in the sparql-examples graph, in the SHACL style", async () => {
    serve(RDF_XML);
    const store = await getStore({ url: "https://x.example/graph.rdf" }, ENDPOINT);

    expect(
      select(
        store,
        `PREFIX sh: <http://www.w3.org/ns/shacl#>
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        SELECT ?prefix ?type WHERE {
          GRAPH <${GRAPH}> {
            ?o a owl:Ontology ; owl:imports sh: ; sh:declare ?d .
            ?d sh:prefix ?prefix ; sh:namespace ?namespace .
          }
          BIND(DATATYPE(?namespace) AS ?type)
        } ORDER BY ?prefix`,
      ),
    ).toEqual([
      { prefix: "rdf", type: "http://www.w3.org/2001/XMLSchema#anyURI" },
      { prefix: "schema", type: "http://www.w3.org/2001/XMLSchema#anyURI" },
    ]);
  });

  it("aren't added without an endpoint URL", async () => {
    serve(TURTLE);
    const store = await getStore({ url: "https://x.example/no-endpoint.ttl" });

    expect(select(store, EDITOR_PREFIX_QUERY)).toEqual([]);
  });

  it("aren't added for a format without prefixes", async () => {
    serve('<https://example.org/a> <https://schema.org/name> "A" .\n');
    const store = await getStore({ url: "https://x.example/plain.nt" }, ENDPOINT);

    expect(store.query("ASK { GRAPH ?g { ?s ?p ?o } }")).toBe(false);
  });
});
