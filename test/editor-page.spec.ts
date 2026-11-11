import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { acceptsHtml, DEFAULT_CSS, EDITOR_SCRIPT } from "../src/editor-page";
import worker from "../src/index";

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

async function callWorker(request: Request, env: Partial<Env> = {}): Promise<Response> {
  const incoming = new Request<unknown, IncomingRequestCfProperties>(request);
  const ctx = createExecutionContext();
  // No data needed: the editor page never loads the store.
  const testEnv = { DATA_URL: "https://data.example/books.ttl", ...env } as Env;
  const response = await worker.fetch!(incoming, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("acceptsHtml", () => {
  it.each([
    [BROWSER_ACCEPT, true],
    ["application/xhtml+xml", true],
    ["TEXT/HTML; charset=utf-8", true],
    ["text/html;q=0", false],
    ["text/html;q=0.0, application/sparql-results+json", false],
    ["*/*", false],
    ["application/sparql-results+json", false],
    [null, false],
  ])("%s -> %s", (accept, expected) => {
    expect(acceptsHtml(accept)).toBe(expected);
  });
});

describe("editor page", () => {
  it("is what a browser gets from /sparql without a query", async () => {
    const response = await callWorker(
      new Request("https://my-endpoint.example/sparql", { headers: { Accept: BROWSER_ACCEPT } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Vary")).toBe("Accept");
    const html = await response.text();
    expect(html).toContain(`<script type="module" src="${EDITOR_SCRIPT}"></script>`);
    expect(html).toContain('<sparql-editor endpoint="https://my-endpoint.example/sparql">');
    expect(html).toContain("https://data.example/books.ttl");
    expect(html).toContain(`<style>${DEFAULT_CSS}</style>`);
  });

  it("is also what a browser gets for a POST without a query", async () => {
    const response = await callWorker(
      new Request("https://my-endpoint.example/sparql", {
        method: "POST",
        headers: { Accept: BROWSER_ACCEPT },
      }),
    );

    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("swaps the default CSS for EDITOR_CSS_URL", async () => {
    const response = await callWorker(
      new Request("https://my-endpoint.example/sparql", { headers: { Accept: BROWSER_ACCEPT } }),
      { EDITOR_CSS_URL: "https://style.example/a.css?x=1&y=2" },
    );

    const html = await response.text();
    expect(html).toContain('<link rel="stylesheet" href="https://style.example/a.css?x=1&amp;y=2" />');
    expect(html).not.toContain("<style>");
  });

  it("escapes the data URL", async () => {
    const response = await callWorker(
      new Request("https://my-endpoint.example/sparql", { headers: { Accept: BROWSER_ACCEPT } }),
      { DATA_URL: 'https://data.example/"><script>alert(1)</script>' },
    );

    const html = await response.text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("isn't served to a client that doesn't ask for HTML", async () => {
    const response = await callWorker(
      new Request("https://my-endpoint.example/sparql", { headers: { Accept: "*/*" } }),
    );

    expect(response.status).toBe(400);
  });
});
