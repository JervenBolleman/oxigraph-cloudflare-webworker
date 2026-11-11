---
title: "Public SPARQL endpoints for small data using Oxigraph and Cloudflare Workers"
title_short: "SPARQL in Cloudflare Workers with Oxigraph"
tags:
  - SPARQL
  - ontologies
  - infrastructure
  - WASM
  - cost
  - LOD
authors:
  - name: Jerven Bolleman
    affiliation: 1
    orcid: 0000-0002-7449-1266
  - name: Nicole Redaschi
    affiliation: 1
    orcid: 0000-0001-8890-2268
affiliations:
  - name: Swiss-Prot group, SIB Swiss Institute of Bioinformatics, Geneva, Switzerland
    index: 1
    ror: 002n09z45
date: 11 November 2026
cito-bibliography: paper.bib
event: BH26EU
biohackathon_name: "BioHackathon Europe 2026"
biohackathon_url: "https://biohackathon-europe.org/"
biohackathon_location: "Barcelona, Spain, 2026"
group: "Project 15"
git_url: "https://github.com/JervenBolleman/oxigraph-cloudflare-webworker"
authors_short: "Bolleman \\emph{et al.}"
---

# Abstract

SPARQL is a query language used to query linked data, RDF and ontologies by users and LLMs.
Some projects cannot afford to maintain such infrastructure and depend in general on free resources such as those provided by GitHub and others.
We now add a new capability to host a SPARQL endpoint in Cloudflare Workers.
This new capability depends on an existing SPARQL engine called Oxigraph, which is compiled into WASM and wrapped in this project to provide some nice-to-have features.

# Introduction

The Semantic Web is great for sharing linked data.
Querying must however be done by client-side agents or publicly provided SPARQL endpoints [@sparql11-query].
There are a significant number of SPARQL endpoints available in the life sciences [@sibweb; @yummydata; @uniprot; @idsm] and other fields of endeavour [@lindas; @epo; @wdqs].
It is an unfortunate truth that any public infrastructure has a cost associated with it and that is not always affordable for small projects, which often depend on a great deal of volunteer resources.
This cost is one of the reasons why few small databases and datasets make their data available via server-side SPARQL.
Two alternatives exist:

1. Client-side SPARQL (e.g. [@comunica]) makes it possible to query such small datasets on demand.
2. Triple Pattern Fragments [@tpf] servers may allow their client-based query engines to also answer SPARQL queries.

However, neither in-browser client-side SPARQL nor Triple Pattern Fragments support the SPARQL protocol [@SPARQL-protocol], so neither can participate as a full member in the SPARQL federation.
To make it more affordable to host a public SPARQL endpoint we propose a solution using the Cloudflare Workers [@webworker] technology that works on their free tier.
This proposed solution will allow small RDF and ontology data providers to give their users a server-side SPARQL solution.

# Implementation

Upon receiving a SPARQL query, a cold Cloudflare Worker:

0. Starts a Worker isolate
1. Fetches a static RDF file (Turtle [@turtle], RDF/XML [@rdf/xml], N-Triples [@ntriples], JSON-LD [@jsonld] etc.) from a configured location
2. Adds some metadata triples to the fetched RDF file
3. Loads this all into an in-memory SPARQL engine
4. Executes the SPARQL query and lets the SPARQL engine reply

If the Cloudflare Worker isolate is still available on a later request, it skips directly to step 4.
The isolate/process is managed by the Cloudflare infrastructure.

The core code of the SPARQL engine depends on Oxigraph [@oxigraph] compiled as a WASM [@wasm] package that answers the actual query.
We have added an HTML view with editor [@sib-query-editor] and robots.txt as well as a few other small amenities.
The code can be further adapted but allows project-specific styling with CSS.
The Cloudflare Workers and Oxigraph are packaged and deployed using a Node.js-based pipeline.

# Example

With a Cloudflare account and Node.js/npm installed on your local machine, run:

```sh
npm install
npx wrangler login
npm run new-worker -- edam-latest https://edamontology.org/EDAM.owl
```

This is enough to create a SPARQL endpoint for the EDAM [@edam2021] ontology.
To generate a nice-looking URI for the SPARQL endpoint see the documentation at [Cloudflare](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

# Limitations

This approach is limited by the generosity of Cloudflare and the limits they set on their Workers.
In practical terms that means ontologies larger than 50 MB will not work in the free tier.
A key limitation is that the query answering (including the data fetch when cold starting a Worker isolate) must happen within 10 ms per request.
Experimentally it seems that this is doable for ontologies stored on GitHub Pages and simple queries, as demonstrated in listing 1.

-----------------------------------------------------------------------------------------------------------------

```sh
# querying the edam ontology via the proposed Cloudflare worker

curl 'https://edam.jerven-bolleman.workers.dev/sparql' \
  --data-urlencode 'query=PREFIX owl: <http://www.w3.org/2002/07/owl#> SELECT * WHERE { ?s a owl:Class } LIMIT 10' -G
```

-----------------------------------------------------------------------------------------------------------------

Listing 1: Simple query to list the first 10 found classes in the EDAM ontology

-----------------------------------------------------------------------------------------------------------------


Ontologies or RDF data in JSON-LD with a large number of remote `@context` declarations are also unlikely to be successful.
In practice these endpoints are also limited to 100,000 requests per day, which should be sufficient for many use cases.

These limits are significantly more generous if using a paid Cloudflare account.
While the same approach can be used in other infrastructure, this specific code is limited to the Cloudflare ecosystem.

# Discussion

Just having a SPARQL endpoint available does not guarantee that end-users can do all the queries they want [@fed_problems].
However, it enables a new set of use cases especially when considering SPARQL query federation.
The SPARQL query federation is a key use case for end users [@sparqlllm], as we can now combine small ontologies such as the ECO [@eco] and the UniProt SPARQL endpoint on the fly, reaching beyond what each database is capabable of by itself.

-------------------------------------------------------------------------

```sparql
PREFIX up: <http://purl.uniprot.org/core/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?sub WHERE {
  SERVICE <https://eco.jerven-bolleman.workers.dev/sparql/> {
    ?sub rdfs:subClassOf+ <http://purl.obolibrary.org/obo/ECO_0000006> .
  }
  ?thing up:evidence ?sub .
```

-------------------------------------------------------------------------

Listing 2: Queryin which experimental ECO codes are used in UniProt

-------------------------------------------------------------------------

# Conclusion

We now have an affordable option for small RDF datasets or ontologies to provide a SPARQL endpoint, that requires next to no maintenance and gives acceptable performance.
We hope that we will now see more SPARQL endpoints, where the data is controlled by the data providers instead of aggregators.

# AI declaration

Very significant amounts of the code and README were written with Claude Opus 5.5.
This paper was reviewed by Claude Opus 5.5.
The authors stand by the work as is, and have reviewed, corrected, and validated the output.

# Acknowledgements

UniProt Grant
Oxigraph developers
Cloudflare
