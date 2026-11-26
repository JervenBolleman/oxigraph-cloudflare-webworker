import { afterEach, describe, expect, it, vi } from "vitest";
import { getStore } from "../src/store";

const ALICE = '<https://example.org/a> <https://schema.org/name> "Alice" .\n';
const BOB = '<https://example.org/a> <https://schema.org/name> "Bob" .\n';

// Answers each fetch of the data file with the next of `responses`, and
// records the requests.
function serve(...responses: (() => Response)[]) {
  const requests: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    requests.push(new Request(input, init));
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  });
  return requests;
}

const ok = (body: string, headers: Record<string, string>) => () => new Response(body, { headers });
const notModified = (headers: Record<string, string> = {}) => () => new Response(null, { status: 304, headers });

let files = 0;
const source = () => ({ url: `https://data.example/refresh-${files++}.ttl` });

async function name(store: Awaited<ReturnType<typeof getStore>>): Promise<string> {
  const rows = store.query("SELECT ?n WHERE { ?s <https://schema.org/name> ?n }") as Map<string, { value: string }>[];
  return rows[0].get("n")!.value;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refetching the data file at cache expiry", () => {
  it("doesn't ask while the data is fresh", async () => {
    const requests = serve(ok(ALICE, { "Cache-Control": "max-age=3600" }));
    const data = source();

    const first = await getStore(data);
    expect(await getStore(data)).toBe(first);
    expect(requests).toHaveLength(1);
  });

  it("asks with the validators once stale, and keeps the store on a 304", async () => {
    const validators = { ETag: '"v1"', "Last-Modified": "Wed, 25 Nov 2026 10:00:00 GMT" };
    const requests = serve(
      ok(ALICE, { "Cache-Control": "max-age=0", ...validators }),
      notModified({ "Cache-Control": "max-age=3600" }),
    );
    const data = source();

    const first = await getStore(data);
    expect(await getStore(data)).toBe(first);
    expect(requests).toHaveLength(2);
    expect(requests[1].headers.get("If-None-Match")).toBe('"v1"');
    expect(requests[1].headers.get("If-Modified-Since")).toBe("Wed, 25 Nov 2026 10:00:00 GMT");
    expect(requests[1].headers.get("Accept")).toBe("text/turtle, */*;q=0.1");

    // The 304's max-age renewed the lifetime: no more asking for now.
    expect(await getStore(data)).toBe(first);
    expect(requests).toHaveLength(2);
  });

  it("keeps the earlier lifetime headers that a 304 doesn't repeat, with the 304's own Age", async () => {
    // Fetched already at the end of its hour in a cache, so stale at once.
    const requests = serve(
      ok(ALICE, { "Cache-Control": "max-age=3600", Age: "3600", ETag: '"v1"' }),
      notModified(),
    );
    const data = source();

    const first = await getStore(data);
    expect(await getStore(data)).toBe(first);
    expect(await getStore(data)).toBe(first);
    expect(requests).toHaveLength(2);
  });

  it("loads new data when the file changed", async () => {
    serve(ok(ALICE, { "Cache-Control": "max-age=0", ETag: '"v1"' }), ok(BOB, { ETag: '"v2"' }));
    const data = source();

    const first = await getStore(data);
    const second = await getStore(data);
    expect(second).not.toBe(first);
    expect(await name(second)).toBe("Bob");
  });

  it("keeps serving the data it has when asking fails, and waits before asking again", async () => {
    const requests = serve(ok(ALICE, { "Cache-Control": "max-age=0" }), () => {
      throw new Error("network down");
    });
    const data = source();

    const first = await getStore(data);
    expect(await getStore(data)).toBe(first);
    expect(await getStore(data)).toBe(first);
    expect(requests).toHaveLength(2);
  });

  it("never asks again about a file without a cache lifetime", async () => {
    const requests = serve(ok(ALICE, { ETag: '"v1"' }));
    const data = source();

    await getStore(data);
    await getStore(data);
    expect(requests).toHaveLength(1);
  });

  it("asks every time about a file served with no-cache", async () => {
    const requests = serve(
      ok(ALICE, { "Cache-Control": "no-cache", ETag: '"v1"' }),
      notModified(),
      notModified(),
    );
    const data = source();

    await getStore(data);
    await getStore(data);
    await getStore(data);
    expect(requests).toHaveLength(3);
  });

  it("asks once for requests that arrive together", async () => {
    const requests = serve(ok(ALICE, { "Cache-Control": "max-age=0", ETag: '"v1"' }), notModified());
    const data = source();

    const first = await getStore(data);
    const stores = await Promise.all([getStore(data), getStore(data), getStore(data)]);
    expect(stores.every((store) => store === first)).toBe(true);
    expect(requests).toHaveLength(2);
  });
});
