#!/usr/bin/env node
// `npm run deploy`: runs `wrangler deploy` with the given arguments, but
// refuses while the config's DATA_URL is still the example.com placeholder,
// which would publish an endpoint that can't load any data.
//
//   npm run deploy                                # wrangler.jsonc
//   npm run deploy -- -c workers/<name>.jsonc     # a named Worker

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);

function configPath() {
  for (let i = 0; i < args.length; i++) {
    const match = args[i].match(/^(?:-c|--config)(?:=(.*))?$/);
    if (match) {
      return match[1] ?? args[i + 1];
    }
  }
  return "wrangler.jsonc";
}

// JSONC to JSON: drops comments and trailing commas, leaving strings (and
// the // in their URLs) alone.
function parseJsonc(text) {
  let json = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const end = text.slice(i).match(/^"(?:[^"\\]|\\.)*"/)[0];
      json += end;
      i += end.length - 1;
    } else if (text.startsWith("//", i)) {
      i = text.indexOf("\n", i) - 1;
      if (i < 0) break;
    } else if (text.startsWith("/*", i)) {
      i = text.indexOf("*/", i) + 1;
    } else {
      json += text[i];
    }
  }
  return JSON.parse(json.replace(/,(\s*[}\]])/g, "$1"));
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const path = configPath();
// A --var DATA_URL:... on the command line overrides the config.
const overridden = args.some((arg, i) => arg === "--var" && args[i + 1]?.startsWith("DATA_URL:"));

if (!overridden) {
  let dataUrl;
  try {
    dataUrl = parseJsonc(readFileSync(path, "utf8")).vars?.DATA_URL;
  } catch (error) {
    fail(`could not read DATA_URL from ${path}: ${error.message}`);
  }

  let host;
  try {
    host = new URL(dataUrl).hostname;
  } catch {
    host = undefined;
  }
  if (host === "example.com" || host === "www.example.com") {
    // npm takes `-c <file>` (before any `--`) as its own option, and keeps
    // the value as npm_config_call, so the config never reaches wrangler.
    const swallowed = process.env.npm_config_call;
    fail(
      swallowed && path === "wrangler.jsonc"
        ? `npm took "-c ${swallowed}" as its own option, so wrangler would deploy ` +
            `wrangler.jsonc and its placeholder DATA_URL (${dataUrl}).\n` +
            `Put the arguments after --:\n\n  npm run deploy -- -c ${swallowed}\n`
        : `DATA_URL in ${path} is still the placeholder ${dataUrl}.\n` +
            `Set it to your RDF file's URL, or deploy a named Worker:\n\n` +
            `  npm run deploy -- -c workers/<name>.jsonc\n`,
    );
  }
}

const result = spawnSync("npx", ["wrangler", "deploy", ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
