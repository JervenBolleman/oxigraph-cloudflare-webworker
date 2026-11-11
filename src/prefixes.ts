import { blankNode, defaultGraph, literal, namedNode, quad, type Quad } from "oxigraph/web.js";

// The prefixes a data file declares, written as SHACL prefix declarations
// (sh:declare / sh:prefix / sh:namespace), the way
// https://github.com/sib-swiss/sparql-examples does. The SIB SPARQL editor
// reads them to offer those prefixes in queries.

const SH = "http://www.w3.org/ns/shacl#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL = "http://www.w3.org/2002/07/owl#";
const XSD_ANY_URI = "http://www.w3.org/2001/XMLSchema#anyURI";

// Turtle-family directives, one per line: `@prefix ex: <...> .` or SPARQL
// style `PREFIX ex: <...>`. Anchoring at the start of a line keeps the
// look-alikes inside literals and comments out, in practice if not in theory.
// @prefix is case-sensitive, PREFIX isn't.
const TURTLE_PREFIX =
  /^[ \t]*(?:@prefix|[Pp][Rr][Ee][Ff][Ii][Xx])[ \t]+([A-Za-z][\w.-]*)?:[ \t]*<([^>\s]*)>/gm;
// RDF/XML namespace declarations: xmlns:ex="...".
const XMLNS = /\bxmlns:([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const TURTLE_FAMILY = ["text/turtle", "application/trig", "text/n3"];
const RDF_XML = "application/rdf+xml";

// The graph the editor looks in for an endpoint's query examples, and
// where the prefix declarations go: the same default it uses itself for
// its examples-namespace attribute.
export function sparqlExamplesGraph(endpointUrl: string): string {
  return `${endpointUrl.replace(/\/?$/, "/")}.well-known/sparql-examples/`;
}

// Prefix name to namespace IRI, for the formats that declare prefixes:
// Turtle, TriG, N3 and RDF/XML. Relative namespaces are resolved against
// `baseUrl`. The empty prefix is skipped, as SHACL has no use for it.
export function gleanPrefixes(text: string, format: string, baseUrl: string): Map<string, string> {
  const prefixes = new Map<string, string>();
  const add = (prefix: string | undefined, namespace: string | undefined) => {
    if (!prefix || namespace === undefined) {
      return;
    }
    try {
      prefixes.set(prefix, new URL(namespace, baseUrl).href);
    } catch {
      // Not a usable IRI, e.g. an RDF/XML entity reference like "&ex;".
    }
  };

  if (TURTLE_FAMILY.includes(format)) {
    for (const match of text.matchAll(TURTLE_PREFIX)) {
      add(match[1], match[2]);
    }
  } else if (format === RDF_XML) {
    for (const match of text.matchAll(XMLNS)) {
      if (match[1] !== "xml" && !(match[2] ?? match[3])!.includes("&")) {
        add(match[1], match[2] ?? match[3]);
      }
    }
  }
  return prefixes;
}

// The declarations as quads in `graph`, plus a copy in the default graph:
// the editor asks for them without a GRAPH clause, and this endpoint's
// default graph doesn't include the named graphs. Setting Oxigraph's
// default_graph or use_default_graph_as_union query options instead would
// override a query's own FROM clauses.
export function prefixDeclarations(prefixes: Map<string, string>, graph: string): Quad[] {
  if (prefixes.size === 0) {
    return [];
  }
  // Fresh blank nodes, so they can't clash with any in the data.
  const ontology = blankNode();
  const triples: [Quad["subject"], string, Quad["object"]][] = [
    [ontology, RDF_TYPE, namedNode(`${OWL}Ontology`)],
    [ontology, `${OWL}imports`, namedNode(SH)],
  ];
  for (const [prefix, namespace] of prefixes) {
    const declaration = blankNode();
    triples.push(
      [ontology, `${SH}declare`, declaration],
      [declaration, `${SH}prefix`, literal(prefix)],
      [declaration, `${SH}namespace`, literal(namespace, namedNode(XSD_ANY_URI))],
    );
  }
  return [namedNode(graph), defaultGraph()].flatMap((g) =>
    triples.map(([s, p, o]) => quad(s, namedNode(p), o, g)),
  );
}
