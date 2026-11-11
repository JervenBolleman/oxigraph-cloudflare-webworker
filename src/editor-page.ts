// The HTML page a browser gets from /sparql when it sends no query: the
// SIB SPARQL editor (https://github.com/sib-swiss/sparql-editor), set up to
// query this endpoint.

// Pinned, so a new release can't change the page without a deploy.
export const EDITOR_SCRIPT = "https://esm.sh/@sib-swiss/sparql-editor@0.2.15";

// Kept small on purpose: just enough to give the editor the page. Set
// EDITOR_CSS_URL to replace it with a stylesheet of your own.
export const DEFAULT_CSS = `
:root {
  color-scheme: light;
  font-family: system-ui, sans-serif;
  --btn-color: white;
  --btn-bg-color: #00709b;
}
body {
  margin: 0;
  background: #fff;
  color: #1a1a1a;
}
header {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #ddd;
}
header h1 {
  margin: 0;
  font-size: 1.1rem;
}
header p {
  margin: 0.25rem 0 0;
  font-size: 0.85rem;
  color: #555;
  overflow-wrap: anywhere;
}
main {
  padding: 1rem;
}
`;

// True when the Accept header lists HTML with a non-zero q value, as every
// browser's does for a page load. A bare */* (curl, most SPARQL clients)
// doesn't count, so those still get a plain error for a missing query.
export function acceptsHtml(acceptHeader: string | null): boolean {
  return (acceptHeader ?? "").split(",").some((range) => {
    const [type, ...params] = range.split(";").map((part) => part.trim().toLowerCase());
    if (type !== "text/html" && type !== "application/xhtml+xml") {
      return false;
    }
    const q = params.find((param) => param.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

export function editorPage(endpoint: string, dataUrl: string, cssUrl?: string): string {
  const style = cssUrl
    ? `<link rel="stylesheet" href="${escapeHtml(cssUrl)}" />`
    : `<style>${DEFAULT_CSS}</style>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SPARQL endpoint</title>
    <script type="module" src="${EDITOR_SCRIPT}"></script>
    ${style}
  </head>
  <body>
    <header>
      <h1>SPARQL endpoint</h1>
      <p>Querying <a href="${escapeHtml(dataUrl)}">${escapeHtml(dataUrl)}</a></p>
    </header>
    <main>
      <sparql-editor endpoint="${escapeHtml(endpoint)}"></sparql-editor>
    </main>
  </body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}
