const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("the homepage and editable playground load the shared generator", () => {
  const home = fs.readFileSync("dist/index.html", "utf8");
  const editor = fs.readFileSync("dist/examples/index.html", "utf8");
  const guide = fs.readFileSync("dist/docs/examples/index.html", "utf8");
  assert.match(home, /id="ast-tree"/);
  assert.match(home, /href="\/zast-site\/examples\/"/);
  assert.match(editor, /<textarea id="json-input"/);
  for (const view of ["zig", "api", "ast", "tokens"]) {
    assert(editor.includes('id="panel-' + view + '"'), view);
  }
  for (const page of [home, editor]) {
    assert.match(page, /src="\/zast-site\/playground.js"/);
    assert.match(page, /data-wasm="\/zast-site\/playground.wasm"/);
  }
  assert.match(guide, /href="\.\.\/\.\.\/examples\/\?example=constant"/);
  for (const asset of ["tree.js", "ast-bark.webp", "ast-forest.webp", "ast-leaf.webp", "ast-roots.webp"]) {
    assert(fs.statSync(path.join("dist", asset)).size > 0, asset);
  }
});
