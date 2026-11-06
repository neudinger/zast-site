const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("the guide snapshots, catalogue, and page agree with the pinned Zast guide", async () => {
  const source = fs.readFileSync(path.join(process.argv[2], "docs/examples.md"), "utf8");
  const snapshots = JSON.parse(fs.readFileSync("wasm/guide-catalog.json", "utf8"));
  const { catalog } = await import("../assets/catalog.js");
  const page = fs.readFileSync("dist/docs/examples/index.html", "utf8");
  assert.equal(snapshots.length, 13);
  assert.deepEqual(snapshots.map(({ number }) => number), Array.from({ length: 13 }, (_, index) => index + 1));
  for (const { id, body, expected } of snapshots) {
    assert(body.includes("output_name"), id);
    assert(source.includes(expected), id);
    assert.equal(catalog.find(entry => entry.id === id).expected, expected);
    assert(page.includes('id="' + id + '"'), id);
  }
  assert.equal(snapshots[0].expected, "pub const answer: u32 = 42;\n");
  assert.match(fs.readFileSync("wasm/GuideExamples.zig", "utf8"), /pub fn emit\(kind: Kind,/);
  assert.deepEqual(fs.readFileSync("dist/catalog.js"), fs.readFileSync("assets/catalog.js"));
});
