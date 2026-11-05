const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("the site publishes the homepage, guides, and theme at the Pages prefix", () => {
  const home = fs.readFileSync("dist/index.html", "utf8");
  const docs = fs.readFileSync("dist/docs/index.html", "utf8");
  const guide = fs.readFileSync("dist/docs/getting-started/index.html", "utf8");
  assert.match(home, /Write in Zig\./);
  assert.match(home, /href="\/zast-site\/site.css"/);
  assert.match(home, /href="\/zast-site\/docs\/"/);
  assert.match(docs, /href="\/zast-site\/docs\/getting-started\/"/);
  assert.match(guide, /render an inferred enum/);
  assert.match(guide, /id="a-complete-example"/);
  for (const page of [home, docs, guide]) assert.doesNotMatch(page, /<extend|[$]page\./);
  assert(fs.statSync("dist/site.css").size > 0);
  assert(fs.statSync("dist/fonts/InterVariable.woff2").size > 0);
});
