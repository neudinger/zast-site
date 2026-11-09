const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// Use the published archive, including internal modules and field docs, so the
// coverage follows the built API rather than a hand-maintained snippet list.
function apiExampleCorpus() {
  const archive = zlib.gunzipSync(fs.readFileSync(
    path.resolve(__dirname, "../dist/docs/api/sources.tar.gz"),
  ));
  const examples = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString().replace(/\0.*$/s, "");
    const filename = [field(345, 500), field(0, 100)].filter(Boolean).join("/");
    const size = Number.parseInt(field(124, 136).trim() || "0", 8);
    assert(Number.isSafeInteger(size) && size >= 0, "Valid archive entry size");
    assert(offset + 512 + size <= archive.length, "Complete archive entry");
    if (filename.startsWith("zast/") && filename.endsWith(".zig")) {
      const source = archive.subarray(offset + 512, offset + 512 + size).toString();
      for (const comments of source.matchAll(/(?:^[\t ]*\/\/[/!][^\n]*(?:\n|$))+/gm)) {
        const markdown = comments[0].replace(/^[\t ]*\/\/[/!] ?/gm, "");
        const fences = /^ {0,3}(`{3,}|~{3,})([\w+-]*)[\t ]*\n([\s\S]*?)^ {0,3}\1[\t ]*$/gm;
        for (const fence of markdown.matchAll(fences)) {
          examples.push({ filename, language: fence[2], source: fence[3] });
        }
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert(examples.some(example => example.source === "-(1 << 4)\n"), "Include expression fragments");
  assert(examples.some(example => example.language === "text"), "Include plain-text output");
  return examples;
}

function textFromHighlight(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function checkApiExamples() {
  const { isZigExample, highlightApiExamples } = await import("../assets/api-examples.js");
  const tokenExample = [
    'const const_token = try context.token(allocator, .keyword_const, null);',
    'const name_token = try context.token(allocator, .identifier, "answer");',
    "// Tokens are syntax only; create the declaration's node separately.",
    "",
  ].join("\n");
  for (const source of [
    tokenExample,
    'const number_node = try context.addNode(allocator, .number_literal, number_token, undefined);',
    'var children = try ChildNodes.init(allocator, &context, 3, 2);',
    'const member_node = try function_decl.emitNode(allocator, &context, "identity", .public);',
    'enum(u8) { unknown = 0, ok = 1, _ }',
    'struct { count: u32, }',
    'union(enum) { none, number: u32, boolean: bool, }',
    'bytes: []const u8',
    'fn (u32) u32',
    '{\n    const answer = 42;\n    return answer;\n}',
    'errdefer context.deinit(allocator);',
    '-(1 << 4)',
    '(32 >> 2)',
    '1 + 2 * 3',
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
    '"const answer "', 'const message = "try context.token()";',
    '// const token = try context.token(allocator, .comma, null);',
    'Container -> FunctionDeclaration -> Block -> statements',
    'context.extra_data.items = { 1, 2, 3, 0, 3 }\nrange_index = 3\n',
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
  const tokens = code(tokenExample);
  const expectedOutput = code('"const answer "\n');
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
  let blocks = [example, tokens, expectedOutput, shell, output, explicit, bare, otherLanguage, source, signature, compiler];
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
  assert.equal(tokens.writes, 1, "AstContext.token's example receives highlighting");
  assert(tokens.innerHTML.includes('class="syntax-keyword">try</span>'));
  assert(tokens.innerHTML.includes('class="syntax-string">&quot;answer&quot;</span>'));
  assert(tokens.innerHTML.includes('class="syntax-comment">// Tokens are syntax only;'));
  assert.equal(textFromHighlight(tokens.innerHTML), tokenExample, "Highlighting preserves the copied example text");
  assert.equal(explicit.writes, 1);
  for (const block of [expectedOutput, shell, output, otherLanguage, source, signature, compiler]) {
    assert.equal(block.writes, 0, "non-Zig or compiler-owned code stays unchanged");
  }
  assert.equal(compiler.innerHTML, compilerMarkup, "compiler links and spans are preserved");
  notify();
  assert.equal(example.writes, 1, "observing inserted spans is idempotent");
  assert.equal(tokens.writes, 1, "Token examples remain stable after insertion");
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

  const corpus = apiExampleCorpus();
  const corpusBlocks = corpus.map(example => ({ ...example, block: code(example.source) }));
  blocks = corpusBlocks.map(example => example.block);
  notify();
  const counts = {};
  for (const { filename, language, source, block } of corpusBlocks) {
    const label = `${filename} (${language}): ${source}`;
    assert(["zig", "text"].includes(language), "Unverified API example language: " + label);
    counts[language] = (counts[language] || 0) + 1;
    if (language === "zig") {
      assert.equal(block.writes, 1, "Every Zig fence is highlighted: " + label);
      assert(block.innerHTML.includes('class="syntax-'), "Visible token colors: " + label);
      assert.equal(textFromHighlight(block.innerHTML), source, "Preserve source bytes: " + label);
    } else {
      assert.equal(block.writes, 0, "Plain-text output stays literal: " + label);
    }
  }
  notify();
  for (const { language, block } of corpusBlocks) {
    assert.equal(block.writes, language === "zig" ? 1 : 0, "Corpus highlighting is idempotent");
  }
  console.log(JSON.stringify({ apiExampleCorpus: counts, checks: "highlighting, exact text, plain output, idempotence" }));
}

module.exports = { checkApiExamples };
if (require.main === module) checkApiExamples().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
