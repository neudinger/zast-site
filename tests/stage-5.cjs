const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { gunzipSync } = require("node:zlib");
const { checkApiExamples } = require("./api-examples.cjs");

test("the published API viewer preserves the compiler's Wasm and sources", () => {
  const compiler = process.argv[3];
  const published = "dist/docs/api";
  const wasm = fs.readFileSync(path.join(published, "main.wasm"));
  const archive = fs.readFileSync(path.join(published, "sources.tar.gz"));
  const script = fs.readFileSync(path.join(published, "main.js"), "utf8");
  const page = fs.readFileSync(path.join(published, "index.html"), "utf8");
  assert(WebAssembly.validate(wasm));
  assert.deepEqual(wasm, fs.readFileSync(path.join(compiler, "main.wasm")));
  assert.deepEqual(gunzipSync(archive), fs.readFileSync(path.join(compiler, "sources.tar")));
  assert.match(script, /new DecompressionStream\("gzip"\)/);
  assert.match(page, /href="sources.tar.gz"/);
  assert.match(page, /class="api-content"/);
  assert.match(page, /data-reading-surface="api"/);
});

test("API example highlighting preserves the compiler's documented source", checkApiExamples);
