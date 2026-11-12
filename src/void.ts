import { blankNode, defaultGraph, literal, namedNode, quad, type Quad, type Store } from "oxigraph/web.js";

// A VoID description of the data (classes, and per class the properties
// used with their object classes and datatypes), the shape the SIB SPARQL
// editor reads for its autocomplete. Modelled on kgsteward's
// make_void_description (https://github.com/sib-swiss/kgsteward), with one
// property partition per subject class and property rather than per
// property, so the editor suggests a property only for the classes it is
// used with.

const VOID = "http://rdfs.org/ns/void#";
const VOID_EXT = "http://ldf.fi/void-ext#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const XSD_INTEGER = "http://www.w3.org/2001/XMLSchema#integer";

// Over every graph of the data, named graphs included.
const UNION = { use_default_graph_as_union: true };

const CLASSES = `SELECT ?class (COUNT(DISTINCT ?s) AS ?entities)
WHERE { ?s a ?class } GROUP BY ?class`;

const PROPERTIES = `SELECT ?class ?prop (COUNT(*) AS ?triples)
WHERE { ?s a ?class ; ?prop ?o FILTER(?prop != <${RDF_TYPE}>) } GROUP BY ?class ?prop`;

const OBJECT_CLASSES = `SELECT DISTINCT ?class ?prop ?objectClass
WHERE { ?s a ?class ; ?prop ?o . ?o a ?objectClass FILTER(?prop != <${RDF_TYPE}>) }`;

const DATATYPES = `SELECT DISTINCT ?class ?prop ?datatype
WHERE { ?s a ?class ; ?prop ?o FILTER(isLiteral(?o)) BIND(DATATYPE(?o) AS ?datatype) }`;

type Row = Map<string, { value: string }>;

// The VoID graph's name: VoID's own well-known path, below the endpoint.
export function voidGraph(endpointUrl: string): string {
  return `${endpointUrl.replace(/\/?$/, "/")}.well-known/void`;
}

// The description as quads in `graph`, plus a copy in the default graph:
// like the prefix declarations (see src/prefixes.ts), the editor asks for it
// without a GRAPH clause. Must run before anything but the data is added.
export function voidDescription(store: Store, graph: string): Quad[] {
  const select = (query: string) => store.query(query, UNION) as Row[];
  const count = (row: Row, key: string) => literal(row.get(key)!.value, namedNode(XSD_INTEGER));

  const total = select("SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }")[0];
  // Fresh blank nodes, so they can't clash with any in the data.
  const dataset = blankNode();
  const triples: [Quad["subject"], string, Quad["object"]][] = [
    [dataset, RDF_TYPE, namedNode(`${VOID}Dataset`)],
    [dataset, `${VOID}triples`, count(total, "n")],
  ];

  const classPartitions = new Map<string, ReturnType<typeof blankNode>>();
  for (const row of select(CLASSES)) {
    const cls = row.get("class")!.value;
    const partition = blankNode();
    classPartitions.set(cls, partition);
    triples.push(
      [dataset, `${VOID}classPartition`, partition],
      [partition, `${VOID}class`, namedNode(cls)],
      [partition, `${VOID}entities`, count(row, "entities")],
    );
  }

  const propertyPartitions = new Map<string, ReturnType<typeof blankNode>>();
  const key = (row: Row) => JSON.stringify([row.get("class")!.value, row.get("prop")!.value]);
  for (const row of select(PROPERTIES)) {
    const partition = blankNode();
    propertyPartitions.set(key(row), partition);
    triples.push(
      [classPartitions.get(row.get("class")!.value)!, `${VOID}propertyPartition`, partition],
      [partition, `${VOID}property`, namedNode(row.get("prop")!.value)],
      [partition, `${VOID}triples`, count(row, "triples")],
    );
  }

  for (const row of select(OBJECT_CLASSES)) {
    triples.push([
      propertyPartitions.get(key(row))!,
      `${VOID}classPartition`,
      classPartitions.get(row.get("objectClass")!.value)!,
    ]);
  }

  for (const row of select(DATATYPES)) {
    const partition = blankNode();
    triples.push(
      [propertyPartitions.get(key(row))!, `${VOID_EXT}datatypePartition`, partition],
      [partition, `${VOID_EXT}datatype`, namedNode(row.get("datatype")!.value)],
    );
  }

  return [namedNode(graph), defaultGraph()].flatMap((g) =>
    triples.map(([s, p, o]) => quad(s, namedNode(p), o, g)),
  );
}
