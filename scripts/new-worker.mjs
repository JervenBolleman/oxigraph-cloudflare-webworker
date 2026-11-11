#!/usr/bin/env node
// Creates, names and configures a new SPARQL endpoint Worker in one step:
// writes workers/<name>.jsonc (sharing this repo's src/) and deploys it,
// which is what creates the Worker on Cloudflare.
//
//   npm run new-worker -- <name> <data-url> [--format turtle|jsonld|rdfxml] [--accept <header>] [--endpoint-url <url>] [--editor-css <url>] [--no-deploy] [--force]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import FORMAT_LIST from "../src/formats.json" with { type: "json" };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_DIR = join(ROOT, "workers");

// --format accepts a format's name, any of its file extensions or aliases,
// or its media type: turtle, ttl and text/turtle all mean Turtle.
const FORMATS = new Map(
  FORMAT_LIST.flatMap((format) =>
    [format.name, ...format.extensions, ...format.aliases, format.mediaType].map((key) => [
      key,
      format.mediaType,
    ]),
  ),
);
const FORMAT_NAMES = FORMAT_LIST.map((format) => format.name);
const EXTENSIONS = FORMAT_LIST.flatMap((format) => format.extensions);
const EXTENSION_LIST = EXTENSIONS.map((extension) => `.${extension}`).join(", ");
const MEDIA_TYPES = FORMAT_LIST.map((format) => format.mediaType).join(", ");

const USAGE = `Usage: npm run new-worker -- <name> <data-url> [options]

Creates workers/<name>.jsonc and deploys it as a Worker named <name>.

  <name>       Worker name: lowercase letters, digits and dashes
  <data-url>   URL of the RDF file to serve, optionally gzipped

Options:
  --format <format>         Format of <data-url>, one of
                              ${FORMAT_NAMES.join(", ")}
                            or a file extension or media type for one.
                            Default: by the file extension, optionally
                            followed by .gz:
                              ${EXTENSION_LIST}
                            or for a URL without one, by the Content-Type
                            it is served with
  --accept <header>         Accept header to send when fetching <data-url>.
                            Default: asks for the format above
  --endpoint-url <url>      Public URL of the endpoint, e.g. behind a custom
                            domain. Default: /sparql on the Worker's address
  --editor-css <url>        Stylesheet for the SPARQL editor page, replacing
                            the minimal default
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
      "endpoint-url": { type: "string" },
      "editor-css": { type: "string" },
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
  dataFormat = FORMATS.get(values.format.toLowerCase());
  if (!dataFormat) {
    fail(`unknown format ${JSON.stringify(values.format)}: use one of ${FORMAT_NAMES.join(", ")}`);
  }
} else {
  const extension = url.pathname.toLowerCase().replace(/\.gz$/, "").match(/\.([a-z0-9]+)$/)?.[1];
  if (!EXTENSIONS.includes(extension)) {
    formatSource = "from the Content-Type it is served with";
    console.warn(
      `warning: ${url.href} has no known RDF file extension, so the Worker will go by the ` +
        `Content-Type it is served with. Pass --format if that isn't one of ${MEDIA_TYPES}.`,
    );
  }
}

for (const option of ["endpoint-url", "editor-css"]) {
  if (values[option] !== undefined && !/^https?:\/\//.test(values[option])) {
    fail(`--${option} must be an http(s) URL, got ${JSON.stringify(values[option])}`);
  }
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
  vars: {
    DATA_URL: url.href,
    DATA_FORMAT: dataFormat,
    DATA_ACCEPT: values.accept ?? "",
    PUBLIC_ENDPOINT_URL: values["endpoint-url"] ?? "",
    EDITOR_CSS_URL: values["editor-css"] ?? "",
  },
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
