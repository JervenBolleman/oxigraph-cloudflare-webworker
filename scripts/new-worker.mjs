#!/usr/bin/env node
// Creates, names and configures a new SPARQL endpoint Worker in one step:
// writes workers/<name>.jsonc (sharing this repo's src/) and deploys it,
// which is what creates the Worker on Cloudflare.
//
//   npm run new-worker -- <name> <data-url> [--format turtle|jsonld|rdfxml] [--accept <header>] [--no-deploy] [--force]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_DIR = join(ROOT, "workers");

const FORMATS = {
  turtle: "text/turtle",
  ttl: "text/turtle",
  "text/turtle": "text/turtle",
  jsonld: "application/ld+json",
  "json-ld": "application/ld+json",
  "application/ld+json": "application/ld+json",
  rdfxml: "application/rdf+xml",
  "rdf/xml": "application/rdf+xml",
  "application/rdf+xml": "application/rdf+xml",
};

const USAGE = `Usage: npm run new-worker -- <name> <data-url> [options]

Creates workers/<name>.jsonc and deploys it as a Worker named <name>.

  <name>       Worker name: lowercase letters, digits and dashes
  <data-url>   URL of the Turtle, JSON-LD or RDF/XML file to serve,
               optionally gzipped

Options:
  --format <turtle|jsonld|rdfxml>
                            Format of <data-url>. Default: by its file
                            extension (.ttl, .jsonld, .json, .rdf, .owl,
                            optionally followed by .gz), or for a URL
                            without one, by the Content-Type it is served
                            with
  --accept <header>         Accept header to send when fetching <data-url>.
                            Default: asks for the format above
  --no-deploy               Only write the config, don't deploy
  --force                   Overwrite an existing workers/<name>.jsonc
  -h, --help                Show this help
`;

function fail(message) {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      format: { type: "string" },
      accept: { type: "string" },
      "no-deploy": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (error) {
  fail(error.message);
}
const { values, positionals } = parsed;

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (positionals.length !== 2) {
  fail("expected exactly a <name> and a <data-url>");
}
const [name, dataUrl] = positionals;

// Cloudflare's rule for Worker names, which also become the
// <name>.<subdomain>.workers.dev hostname.
if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
  fail(
    `invalid worker name ${JSON.stringify(name)}: use 1-63 lowercase letters, digits and dashes, not starting or ending with a dash`,
  );
}

let url;
try {
  url = new URL(dataUrl);
} catch {
  fail(`invalid data URL ${JSON.stringify(dataUrl)}`);
}
if (url.protocol !== "https:" && url.protocol !== "http:") {
  fail(`data URL must be http(s), got ${url.protocol}`);
}

// Left empty unless --format is given: the Worker then goes by the file
// extension itself (see formatFromUrl in src/store.ts).
let dataFormat = "";
let formatSource = "from the file extension";
if (values.format !== undefined) {
  dataFormat = FORMATS[values.format.toLowerCase()];
  if (!dataFormat) {
    fail(`unknown format ${JSON.stringify(values.format)}: use turtle, jsonld or rdfxml`);
  }
} else if (!/\.(ttl|jsonld|json|rdf|owl)(\.gz)?$/i.test(url.pathname)) {
  formatSource = "from the Content-Type it is served with";
  console.warn(
    `warning: ${url.href} has no .ttl/.jsonld/.json/.rdf/.owl extension, so the Worker will go by ` +
      `the Content-Type it is served with. Pass --format if that isn't text/turtle, ` +
      `application/ld+json or application/rdf+xml.`,
  );
}

const configPath = join(WORKERS_DIR, `${name}.jsonc`);
if (existsSync(configPath) && !values.force) {
  fail(`${relative(ROOT, configPath)} already exists; pass --force to overwrite it`);
}

// Keep every endpoint on the same runtime version as the main worker, so
// they all behave like the one the tests run against.
const rootConfig = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
const compatibilityDate = rootConfig.match(/"compatibility_date"\s*:\s*"([^"]+)"/)?.[1];
if (!compatibilityDate) {
  fail("could not read compatibility_date from wrangler.jsonc");
}

const config = {
  $schema: "../node_modules/wrangler/config-schema.json",
  name,
  main: "../src/index.ts",
  compatibility_date: compatibilityDate,
  vars: { DATA_URL: url.href, DATA_FORMAT: dataFormat, DATA_ACCEPT: values.accept ?? "" },
};

mkdirSync(WORKERS_DIR, { recursive: true });
writeFileSync(
  configPath,
  `// Created by \`npm run new-worker\`. Deploy changes with:\n` +
    `//   npx wrangler deploy -c ${relative(ROOT, configPath)}\n` +
    JSON.stringify(config, null, 2) +
    "\n",
);
console.log(
  `Wrote ${relative(ROOT, configPath)} serving ${url.href}\n` +
    `  format: ${dataFormat || formatSource}\n` +
    `  Accept: ${values.accept ?? "asks for that format"}`,
);

if (values["no-deploy"]) {
  console.log(
    `\nNot deployed. To try it locally:\n  npx wrangler dev -c ${relative(ROOT, configPath)}\n` +
      `To create it on Cloudflare:\n  npx wrangler deploy -c ${relative(ROOT, configPath)}`,
  );
  process.exit(0);
}

// The first deploy of a new name is what creates the Worker on Cloudflare.
const result = spawnSync("npx", ["wrangler", "deploy", "-c", configPath], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
