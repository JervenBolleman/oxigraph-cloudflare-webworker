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
There are a significant number of SPARQL endpoints available in the life sciences[@sibweb,@yummydata] and other fields of endevour[@lindas,@epo].
It is an unfortunate truth that any public infrastructure has a cost associated with it and that is not always affordable for small projects, that often depend on a great deal of volenteer resources already.
Which is why few small databases and datasets have their data available via server side SPARQL.
Client side SPARQL [@comunica] makes it possible to query such small datasets on demand.
However, such in browser client SPARQL endpoints do not support the SPARQL protocol [@SPARQL-protocol] and can't participate as a full member in the SPARQL federation.
