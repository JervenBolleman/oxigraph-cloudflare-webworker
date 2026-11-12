import { afterEach, describe, expect, it, vi } from "vitest";
import { getStore } from "../src/store";
import { voidGraph } from "../src/void";

const ENDPOINT = "https://sparql.example.org/sparql";
const SCHEMA = "https://schema.org/";
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const LANG_STRING = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

const TURTLE = `@prefix schema: <https://schema.org/> .
@prefix ex: <https://example.org/> .
ex:alice a schema:Person ; schema:name "Alice" ; schema:knows ex:bob .
ex:bob a schema:Person ; schema:name "Bob"@en .
ex:acme a schema:Organization ; schema:name "Acme" .
`;

// The query the SIB SPARQL editor (0.2.15) sends for its autocomplete,
// trimmed to the variables it reads.
const EDITOR_VOID_QUERY = `PREFIX void:<http://rdfs.org/ns/void#>
PREFIX void-ext:<http://ldf.fi/void-ext#>
SELECT DISTINCT ?subjectClass ?prop ?objectClass ?objectDatatype ?triples
WHERE {
  ?cp void:class ?subjectClass ; void:propertyPartition ?pp .
  ?pp void:property ?prop .
  OPTIONAL { ?pp void:triples ?triples }
  OPTIONAL {
    { ?pp void:classPartition [ void:class ?objectClass ] . }
    UNION
    { ?pp void-ext:datatypePartition [ void-ext:datatype ?objectDatatype ] . }
  }
}`;

function serve(body: string) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body));
}

function select(store: Awaited<ReturnType<typeof getStore>>, query: string): string[] {
  const rows = store.query(query) as Map<string, { value: string }>[];
  return rows
    .map((row) =>
      ["subjectClass", "prop", "objectClass", "objectDatatype", "triples"]
        .map((key) => row.get(key)?.value.replace(SCHEMA, "schema:") ?? "-")
        .join(" "),
    )
    .sort();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VoID description", () => {
  it("answers the editor's VoID query, per subject class", async () => {
    serve(TURTLE);
    const store = await getStore({ url: "https://x.example/void.ttl" }, ENDPOINT);

    expect(select(store, EDITOR_VOID_QUERY)).toEqual(
      [
        `schema:Organization schema:name - ${XSD_STRING} 1`,
        `schema:Person schema:knows schema:Person - 1`,
        `schema:Person schema:name - ${LANG_STRING} 2`,
        `schema:Person schema:name - ${XSD_STRING} 2`,
      ].sort(),
    );
  });

  it("counts classes, entities and triples of the data alone", async () => {
    serve(TURTLE);
    const store = await getStore({ url: "https://x.example/counts.ttl" }, ENDPOINT);

    const rows = store.query(
      `PREFIX void: <http://rdfs.org/ns/void#>
      SELECT ?triples ?class ?entities WHERE {
        GRAPH <${voidGraph(ENDPOINT)}> {
          ?d a void:Dataset ; void:triples ?triples ; void:classPartition ?cp .
          ?cp void:class ?class ; void:entities ?entities .
        }
      } ORDER BY ?class`,
    ) as Map<string, { value: string }>[];
    expect(rows.map((row) => [row.get("triples")!.value, row.get("class")!.value, row.get("entities")!.value])).toEqual([
      ["7", `${SCHEMA}Organization`, "1"],
      ["7", `${SCHEMA}Person`, "2"],
    ]);
  });

  it("describes data in named graphs too", async () => {
    serve(
      "<https://example.org/a> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> " +
        "<https://schema.org/Thing> <https://example.org/g> .\n",
    );
    const store = await getStore({ url: "https://x.example/graphs.nq" }, ENDPOINT);

    expect(
      store.query("ASK { [] <http://rdfs.org/ns/void#class> <https://schema.org/Thing> }"),
    ).toBe(true);
  });

  it("isn't added when switched off, while the prefixes still are", async () => {
    serve(TURTLE);
    const store = await getStore({ url: "https://x.example/void-off.ttl" }, ENDPOINT, {
      describeVoid: false,
    });

    expect(store.query("ASK { ?s a <http://rdfs.org/ns/void#Dataset> }")).toBe(false);
    expect(store.query("ASK { ?s <http://www.w3.org/ns/shacl#prefix> \"schema\" }")).toBe(true);
  });

  it("isn't added without an endpoint URL", async () => {
    serve(TURTLE);
    const store = await getStore({ url: "https://x.example/no-void.ttl" });

    expect(store.query("ASK { ?s a <http://rdfs.org/ns/void#Dataset> }")).toBe(false);
  });
});
