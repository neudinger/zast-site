const assert = require("node:assert/strict");

async function checkApiExamples() {
  const { isZigExample, highlightApiExamples } = await import("../assets/api-examples.js");
  for (const source of [
    "pub const Status = enum { unknown, ok };",
    "fn answer() u32 { return 42; }",
    'test "example" { try check(); }',
    "const context: zast.AstContext = .{};",
    'const std = @import("std");',
    "try declaration.emit(allocator, &context);",
  ]) assert(isZigExample(source), source);
  for (const source of [
    "$ zig build test", "zig build", "All 17 tests passed.", "42",
    '{"name":"Status"}', "const answer = 42;", "console.log(42);",
    "// pub const Status = enum { unknown };", "echo 'pub const Status = enum {};'",
  ]) assert(!isZigExample(source), source);

  function code(source, { documentation = true, children = 0, language = "" } = {}) {
    const classes = new Set(language ? [language] : []);
    let html = source;
    return {
      textContent: source,
      childElementCount: children,
      classList: { contains: name => classes.has(name), [Symbol.iterator]: () => classes.values() },
      closest: () => documentation ? {} : null,
      writes: 0,
      get innerHTML() { return html; },
      set innerHTML(value) {
        html = value;
        this.childElementCount = /<[A-Za-z]/.test(value) ? 1 : 0;
        this.writes++;
      },
    };
  }
  const example = code('pub const text = "<script>&";');
  const shell = code("zig build test");
  const output = code("const answer = 42;");
  const explicit = code("const answer = 42;", { language: "language-zig" });
  const bare = code("{}", { language: "language-zig" });
  const otherLanguage = code("pub const answer = 42;", { language: "language-shell" });
  const source = code("pub const source = 42;", { documentation: false });
  const signature = code("pub fn answer() u32;", { documentation: false });
  const compiler = code(
    '<span class="tok-kw">pub</span> <a id="l1" href="#zast.Expression">Expression</a>',
    { children: 1 },
  );
  const compilerMarkup = compiler.innerHTML;
  let blocks = [example, shell, output, explicit, bare, otherLanguage, source, signature, compiler];
  const root = { querySelectorAll: () => blocks };
  let notify;
  class Observer {
    constructor(callback) { notify = callback; }
    observe(target, options) {
      assert.equal(target, root);
      assert.deepEqual(options, { childList: true, subtree: true, characterData: true });
    }
  }
  assert.equal(highlightApiExamples(null, Observer), null);
  assert(highlightApiExamples(root, Observer) instanceof Observer);
  assert(example.innerHTML.includes('class="syntax-keyword">pub</span>'));
  assert(example.innerHTML.includes("&lt;script&gt;&amp;"));
  assert(!example.innerHTML.includes("<script>"));
  assert.equal(explicit.writes, 1);
  for (const block of [shell, output, otherLanguage, source, signature, compiler]) {
    assert.equal(block.writes, 0, "non-Zig or compiler-owned code stays unchanged");
  }
  assert.equal(compiler.innerHTML, compilerMarkup, "compiler links and spans are preserved");
  notify();
  assert.equal(example.writes, 1, "observing inserted spans is idempotent");
  assert.equal(bare.writes, 1, "unclassified Zig text cannot cause an observation loop");

  const later = code("try example.emit(allocator, &context);");
  blocks.push(later);
  notify();
  assert.equal(later.writes, 1, "late API content receives highlighting");
  const nextPage = code("pub const Next = enum { first };");
  blocks = [nextPage, source, compiler];
  notify();
  assert.equal(nextPage.writes, 1, "navigation replacement receives highlighting");
  assert.equal(source.writes, 0);
  assert.equal(compiler.innerHTML, compilerMarkup);
  notify();
  assert.equal(nextPage.writes, 1);
  bare.textContent = "pub const Replaced = 42;";
  blocks.push(bare);
  notify();
  assert.equal(bare.writes, 2, "replacing text in an existing code element is highlighted");
  assert(bare.innerHTML.includes("Replaced"));
  notify();
  assert.equal(bare.writes, 2);
}

module.exports = { checkApiExamples };
if (require.main === module) checkApiExamples().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
