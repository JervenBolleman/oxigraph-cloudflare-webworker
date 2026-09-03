// SPARQL results formats (for SELECT/ASK) and RDF graph formats (for
// CONSTRUCT/DESCRIBE) that Store.prototype.query's `results_format` option
// understands. Oxigraph picks the right serializer for the query form; we
// just need to turn the client's Accept header into one of these strings.
const SUPPORTED_FORMATS = [
  "application/sparql-results+json",
  "application/sparql-results+xml",
  "text/csv",
  "text/tab-separated-values",
  "text/turtle",
  "application/n-triples",
  "application/n-quads",
  "application/trig",
  "application/rdf+xml",
];

const DEFAULT_FORMAT = "application/sparql-results+json";

// Picks the first media type in the Accept header (ignoring q-values) that
// we can produce, falling back to SPARQL JSON results for `*/*`, a missing
// header, or anything we don't recognise.
export function negotiateFormat(acceptHeader: string | null): string {
  if (!acceptHeader) {
    return DEFAULT_FORMAT;
  }
  const requested = acceptHeader
    .split(",")
    .map((part) => part.split(";")[0]?.trim());
  for (const type of requested) {
    if (type && SUPPORTED_FORMATS.includes(type)) {
      return type;
    }
  }
  return DEFAULT_FORMAT;
}
