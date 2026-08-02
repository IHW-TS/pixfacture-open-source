const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadPaginatedFetchModule = () => {
  const sourcePath = path.join(__dirname, "../../src/lib/paginatedFetch.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    URLSearchParams,
    Response,
  };
  vm.createContext(sandbox);
  new vm.Script(compiled, { filename: "paginatedFetch.ts" }).runInContext(sandbox);
  return module.exports;
};

test("fetchPaginatedList follows backend pagination until total is loaded", async () => {
  const { fetchPaginatedList } = loadPaginatedFetchModule();
  const requestedOffsets = [];
  const rawApi = async (url) => {
    const parsed = new URL(url, "https://app.example.test");
    const offset = Number(parsed.searchParams.get("offset") || 0);
    const limit = Number(parsed.searchParams.get("limit") || 0);
    requestedOffsets.push(offset);
    const remaining = Math.max(0, 450 - offset);
    const count = Math.min(limit, remaining);
    const items = Array.from({ length: count }, (_, index) => ({ id: offset + index + 1 }));
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: { "X-Total-Count": "450" },
    });
  };

  const result = await fetchPaginatedList({ rawApi, endpoint: "/api/customers", limit: 200, maxItems: 1000 });

  assert.equal(result.items.length, 450);
  assert.equal(result.total, 450);
  assert.equal(result.truncated, false);
  assert.deepEqual(requestedOffsets, [0, 200, 400]);
});

test("fetchPaginatedList reports truncation at the configured safety cap", async () => {
  const { fetchPaginatedList } = loadPaginatedFetchModule();
  const rawApi = async (url) => {
    const parsed = new URL(url, "https://app.example.test");
    const offset = Number(parsed.searchParams.get("offset") || 0);
    const limit = Number(parsed.searchParams.get("limit") || 0);
    const items = Array.from({ length: limit }, (_, index) => ({ id: offset + index + 1 }));
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: { "X-Total-Count": "450" },
    });
  };

  const result = await fetchPaginatedList({ rawApi, endpoint: "/api/customers", limit: 200, maxItems: 400 });

  assert.equal(result.items.length, 400);
  assert.equal(result.total, 450);
  assert.equal(result.truncated, true);
});
