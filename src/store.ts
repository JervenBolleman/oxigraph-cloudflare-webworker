import { initSync, Store } from "oxigraph/web.js";
import wasmModule from "oxigraph/web_bg.wasm";

// The wasm-bindgen "web" build normally fetches its .wasm file relative to
// import.meta.url, which doesn't resolve inside a bundled Worker. Wrangler
// already gives us the compiled module directly (as a WebAssembly.Module,
// via its built-in *.wasm import support), so we hand it to initSync and
// skip that fetch entirely.
initSync({ module: wasmModule });

let storePromise: Promise<Store> | undefined;

// Loads the configured Turtle file into an in-memory Store once per Worker
// isolate, then reuses it for every subsequent request that isolate handles.
export function getStore(turtleUrl: string): Promise<Store> {
  if (!storePromise) {
    storePromise = loadStore(turtleUrl).catch((error: unknown) => {
      // Don't cache a failed load: a transient fetch error shouldn't
      // permanently break every future request on this isolate.
      storePromise = undefined;
      throw error;
    });
  }
  return storePromise;
}

async function loadStore(turtleUrl: string): Promise<Store> {
  const response = await fetch(turtleUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Turtle data from ${turtleUrl}: ${response.status} ${response.statusText}`,
    );
  }
  const turtle = await response.text();

  const store = new Store();
  store.load(turtle, { format: "text/turtle", base_iri: turtleUrl });
  return store;
}
