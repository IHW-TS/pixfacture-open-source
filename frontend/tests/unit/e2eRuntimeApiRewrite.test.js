const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SCRIPT = path.resolve(__dirname, "../../scripts/prepare-e2e-runtime-api.mjs");
const INTERNAL_ORIGIN = "http://backend:8000";

const withManifest = (destination, callback, source = "/api/:path*") => {
  const root = mkdtempSync(path.join(tmpdir(), "pixfacture-e2e-rewrite-"));
  const nextDir = path.join(root, ".next");
  const manifestPath = path.join(nextDir, "routes-manifest.json");
  mkdirSync(nextDir);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      rewrites: {
        beforeFiles: [],
        afterFiles: [{ source, destination }],
        fallback: [],
      },
    }),
  );
  try {
    callback({ root, manifestPath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const runRewrite = (root, origin = INTERNAL_ORIGIN) =>
  spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, E2E_RUNTIME_API_ORIGIN: origin },
  });

test("rewrites the baked public API only inside the disposable frontend", () => {
  withManifest("https://app.example.test/api/:path*", ({ root, manifestPath }) => {
    const result = runRewrite(root);
    assert.equal(result.status, 0, result.stderr);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.rewrites.afterFiles[0].destination, "http://backend:8000/api/:path*");
  });
});

test("fails closed when the requested E2E API target is remote", () => {
  withManifest("https://app.example.test/api/:path*", ({ root, manifestPath }) => {
    const before = readFileSync(manifestPath, "utf8");
    const result = runRewrite(root, "https://app.example.test");

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cible API refusée/);
    assert.equal(readFileSync(manifestPath, "utf8"), before);
  });
});

test("fails closed when the compiled API rewrite is missing", () => {
  withManifest(
    "https://app.example.test/not-api/:path*",
    ({ root, manifestPath }) => {
      const before = readFileSync(manifestPath, "utf8");
      const result = runRewrite(root);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /une unique réécriture/);
      assert.equal(readFileSync(manifestPath, "utf8"), before);
    },
    "/not-api/:path*",
  );
});
