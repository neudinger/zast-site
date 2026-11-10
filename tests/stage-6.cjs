const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { checkDocs } = require("./docs.cjs");

test("published guides and the API reference expose documentation navigation", () => {
  const guide = fs.readFileSync("dist/docs/getting-started/index.html", "utf8");
  const api = fs.readFileSync("dist/docs/api/index.html", "utf8");
  for (const page of [guide, api]) {
    assert.match(page, /data-search-dialog/);
    assert.match(page, /src="\/zast-site\/docs.js"/);
  }
  assert.match(api, /data-api-tree/);
  assert.match(api, /data-api-companion/);
});

test("documentation search and examples resolve to real Zast symbols", checkDocs);
