---
title: "Public SPARQL endpoints for small data using OxiGraph and Cloudflare webworkers"
title_short: "SPARQL on webworkers with OxiGraph"
tags:
  - SPARQL
  - ontologies
  - infrastructure
  - WASM
  - Cost
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

SPARQL is a query language used to query linked data, rdf and ontologies by users and LLMs.
Some projects can not afford to maintain such infrastrcture and depend in general on free resources such as provided by github an others.
We now add a new capability to host a SPARQL endpoint in cloudflare webworkers.
This new capability depends on an existing SPARQL engine called OxiGraph, which is compiled into WASM and wrapped in this project to provide some nice to have features.

# Introduction

The Semantic Web is great for sharing linked data. Querying must however be done by client side agents or publicly provided SPARQL endpoints.
There are a significant number of SPARQL endpoints available in the life sciences[@sibweb,@yummydata,@uniprot] and other fields of endevour [@lindas,@epo,@wikidata].
It is an unfortunate truth that any public infrastructure has a cost associated with it and that is not always affordable for small projects, that often depend on a great deal of volenteer resources already.
Which is why few small databases and datasets have their data available via server side SPARQL.
Client side SPARQL [@comunica] makes it possible to query such small datasets on demand.
However, such in browser client SPARQL endpoints do not support the SPARQL protocol [@SPARQL-protocol] and can't participate as a full member in the SPARQL federation.
To make it more afforable to host a public SPARQL endpoint we propose a solution using the Cloudflare webworker[@webworker] technology that works on their free tier.
Allowing small RDF and ontology data providers to also give their users a SPARQL solution.

# Implementation

The webworker implementation that upon rechieving a SPARQL query:
1. Fetches a static RDF file (turtle[@turtle], rdf/xml[@rdf/xml], nt[@ntriples], json-ld[@jsonld] etc.) from a configured location
2. Add some metadata triples to the fetched RDF file
3. Loads this all into an in memory SPARQL engine [@oxigraph]
4. Store this state into the webworkers cache
5. Execute the SPARQL query and let the SPARQL engine reply
6. Shutdown the SPARQL engine

The core code of the SPARQL engine depends on OxiGraph [@OxiGraph] compiled as a WASM package.
This answers the actual query.
We have added a HTML view with editor [@sib-query-editor] and robot.txt as well as a few other small amenities.
The code can be further adapted but allows project specific styling with CSS.
The Cloudflare webworkers and oxigraph are packaged and deployed using a node based pipeline.

# Example

Having a Cloudflare account and node/npm installed on your local machine

```sh
npm install
npx login
npm run new-worker -- edam-latest https://edamontology.org/EDAM.owl
```

This is enough to create a SPARQL endpoint for the EDAM[@edam] ontology.
To generate a nice looking URI for the SPARQL endpoint see the documentation at [Cloudflare](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

# Limitations

This approach is limited by the generousity of Cloudflare and the limits they set on webworkers.
In practical terms that means ontologies larger than 50mb will not work.
Ontologies or RDF data in JSON-LD with a large number of remote `@context` declarations are also unlikely to be successful.
In practice these endpoints are also limited to tens of thousands of queries per day, which should be sufficient for most users.

# Conclusion

We now have an affordable option for small RDF or Ontologies to provide a SPARQL endpoint, that requires near to no maintainance and gives acceptable performance.
We hope that we will now see more SPARQL endpoints, where the data is controlled by the data providers instead of aggregators.
