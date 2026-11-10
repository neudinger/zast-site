const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

async function checkDocs() {
  const { createApiIndex, loadApiIndex, searchEntries, companionFor, companionExamples } =
    await import("../assets/docs-model.js");
  const { catalog } = await import("../assets/catalog.js");
  const directory = path.resolve(__dirname, "../dist/docs/api");
  const wasm = fs.readFileSync(path.join(directory, "main.wasm"));
  const archive = fs.readFileSync(path.join(directory, "sources.tar.gz"));
  const { instance: { exports: api } } = await WebAssembly.instantiate(wasm, { js: { log() {} } });
  const sources = zlib.gunzipSync(archive);
  const pointer = api.alloc(sources.length);
  new Uint8Array(api.memory.buffer, pointer, sources.length).set(sources);
  api.unpack(pointer, sources.length);
  const index = createApiIndex(api);
  assert.equal(index.roots[0].path, "zast");
  assert.deepEqual(index.roots[0].children.map(symbol => symbol.name), [
    "AstContext", "Expression", "Field", "Declaration", "Block", "Container",
    "EnumDeclaration", "UnionDeclaration", "FunctionDeclaration", "StructDeclaration",
  ]);
  const enumeration = index.roots[0].children.find(symbol => symbol.name === "EnumDeclaration");
  assert.deepEqual(enumeration.children.map(symbol => symbol.name), ["init", "emitType", "emit"]);
  const expression = index.roots[0].children.find(symbol => symbol.name === "Expression");
  assert.equal(expression.path, "zast.Expression.Expression", "Resolve public aliases as the compiler does");
  assert(expression.children.some(symbol => symbol.name === "emit"));
  assert(!index.symbols.some(symbol => symbol.name === "emitFields"), "Private helpers stay out of navigation");
  assert.equal(index.roots.length, 1, "Keep dependency modules out of the library navigation");
  assert(index.symbols.every(symbol => symbol.path.startsWith("zast")));
  const encoder = new TextEncoder();
  for (const symbol of index.symbols) {
    const encoded = encoder.encode(symbol.path);
    const pointer = api.set_input_string(encoded.length);
    new Uint8Array(api.memory.buffer, pointer, encoded.length).set(encoded);
    assert.notEqual(api.find_decl(), -1, "Resolvable symbol link: " + symbol.href);
  }
  const entries = index.symbols.map(symbol => ({ title: symbol.path, href: symbol.href }));
  assert.equal(searchEntries(entries, "zast.EnumDeclaration.emit")[0].title, "zast.EnumDeclaration.emit");
  assert(searchEntries(entries, "enumdeclaration emit").every(entry => entry.title.includes("EnumDeclaration")));
  assert.equal(searchEntries(entries, "enumdeclaration emit")[0].title, "zast.EnumDeclaration.emit");
  assert.equal(searchEntries([
    { title: "Guide", searchText: "EnumDeclaration emit" }, ...entries,
  ], "EnumDeclaration emit")[0].title, "zast.EnumDeclaration.emit", "Symbol titles precede guide body matches");
  assert.equal(searchEntries(entries, "no_such_symbol").length, 0);
  assert.equal(searchEntries(entries, "zast", 3).length, 3);
  assert(searchEntries(entries, "EMIT").some(entry => entry.title.endsWith(".emit")));
  for (const [symbol, companion] of Object.entries(companionExamples)) {
    const entry = catalog.find(entry => entry.id === companion.id);
    assert(entry.body && entry.expected && entry.name, "Companions use complete catalogue examples");
    assert(index.symbols.some(entry => entry.path === symbol + ".emit"));
    assert.equal(companionFor(symbol + ".emit"), companion);
    assert.equal(companionFor(symbol + ".emitType"), null, "Other methods keep their own contracts");
  }
  assert.equal(companionFor("src/zast/EnumDeclaration.zig"), null);
  assert.equal(companionFor("zast.Missing.emit"), null);
  assert.equal(companionFor("toString.emit"), null);

  const originalFetch = global.fetch;
  const urls = [];
  try {
    global.fetch = async url => {
      urls.push(String(url));
      return new Response(String(url).endsWith(".wasm") ? wasm : archive);
    };
    const loaded = await loadApiIndex(new URL("https://example.test/zast-site/"));
    assert.deepEqual(loaded, index);
    assert.deepEqual(urls.sort(), [
      "https://example.test/zast-site/docs/api/main.wasm",
      "https://example.test/zast-site/docs/api/sources.tar.gz",
    ]);
    urls.length = 0;
    assert.deepEqual(await loadApiIndex(null, api), index);
    assert.equal(urls.length, 0, "API pages reuse the already-unpacked compiler instance");
    global.fetch = async () => new Response("Unavailable", { status: 503 });
    await assert.rejects(loadApiIndex(new URL("https://example.test/zast-site/")), /API index unavailable/);
  } finally { global.fetch = originalFetch; }
}

module.exports = { checkDocs };
if (require.main === module) checkDocs().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
