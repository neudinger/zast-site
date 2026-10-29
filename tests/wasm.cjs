const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

async function main() {
  const siteDirectory = path.resolve(__dirname, "..");
  assert(WebAssembly.validate(fs.readFileSync(path.join(siteDirectory, "dist/docs/api/main.wasm"))));
  await require("./rotation.cjs").checkRotation();
  await require("./tree.cjs").checkTree();
  await require("./reading.cjs").checkReading();
  await require("./api-examples.cjs").checkApiExamples();
  const { layoutTree, tokenLines, initialBranches, branchView, nodePath } = await import("../assets/tree.js");
  const { catalog, buildApiSource } = await import("../assets/examples.js");
  assert.equal(catalog.length, 24);
  assert.deepEqual(catalog.filter(entry => entry.number).map(entry => entry.number), Array.from({length:15}, (_, index) => index + 1));
  const { highlightJson } = await import("../assets/highlight.js");
  const highlighted = highlightJson('{"name":"<script>alert(1)</script>","value":-2,"ready":true}');
  assert(!highlighted.includes("<script>"));
  assert(highlighted.includes("&lt;script&gt;"));
  assert(highlighted.includes('class="syntax-number">-2</span>'));
  assert(highlighted.includes('class="syntax-number">true</span>'));
  const wasmBytes = fs.readFileSync(path.join(siteDirectory, "dist/playground.wasm"));
  const module = await WebAssembly.compile(wasmBytes);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const { exports: memoryProbe } = await WebAssembly.instantiate(module, {});
  const initialPages = memoryProbe.memory.buffer.byteLength / 65536;
  assert.equal(memoryProbe.memory.grow(256 - initialPages), initialPages);
  assert.throws(() => memoryProbe.memory.grow(1), RangeError);
  const { exports: api } = await WebAssembly.instantiate(module, {});
  assert.deepEqual(Object.keys(api).sort(), [
    "generate", "inputCapacity", "inputPointer", "inspectLength", "inspectPointer",
    "memory", "outputLength", "outputPointer",
  ].sort());
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const read = (pointer, length) => decoder.decode(new Uint8Array(api.memory.buffer, pointer, length));
  function checkTree({ nodes, tokens }) {
    const visited = new Set();
    function visit(index) {
      assert(!visited.has(index), "AST children must form a tree without cycles or shared parents");
      visited.add(index);
      const node = nodes[index];
      assert.equal(node.index, index);
      assert(Number.isInteger(node.first_token) && Number.isInteger(node.last_token));
      assert(node.first_token >= 0 && node.first_token <= node.main_token);
      assert(node.main_token <= node.last_token && node.last_token < tokens.length);
      assert(Array.isArray(node.children));
      let previous = -1;
      for (const child of node.children) {
        assert(Number.isInteger(child) && child > 0 && child < nodes.length, "valid child node index");
        assert(nodes[child].first_token >= previous, "children follow source order");
        assert(nodes[child].first_token >= node.first_token && nodes[child].last_token <= node.last_token, "child span belongs to parent");
        previous = nodes[child].first_token;
        visit(child);
      }
    }
    visit(0);
    assert.equal(visited.size, nodes.length, "every emitted AST node is reachable from root");
  }
  function generate(input) {
    const bytes = encoder.encode(typeof input === "string" ? input : JSON.stringify(input));
    assert(bytes.length <= api.inputCapacity());
    new Uint8Array(api.memory.buffer, api.inputPointer(), bytes.length).set(bytes);
    const status = api.generate(bytes.length);
    const result = {
      status,
      output: read(api.outputPointer(), api.outputLength()),
      inspection: JSON.parse(read(api.inspectPointer(), api.inspectLength())),
    };
    if (status === 0) checkTree(result.inspection);
    return result;
  }

  const fixtures = [
    [
      { name: "Status", fields: [{ name: "unknown" }, { name: "ok" }, { name: "warning" }] },
      "pub const Status = enum {\n    unknown,\n    ok,\n    warning,\n};\n",
    ],
    [
      { name: "Numeric", backing_type: "u8", non_exhaustive: true, fields: [{ name: "unknown", value: 0 }, { name: "ok", value: 1 }] },
      "pub const Numeric = enum(u8) {\n    unknown = 0,\n    ok = 1,\n    _,\n};\n",
    ],
    [
      { name: "Signed", backing_type: "i16", fields: [{ name: "negative", value: -4 }, { name: "zero", value: 0 }] },
      "pub const Signed = enum(i16) {\n    negative = -4,\n    zero = 0,\n};\n",
    ],
    [{ name: "Empty", fields: [] }, "pub const Empty = enum {};\n"],
    [
      { name: "Offset", backing_type: "u32", non_exhaustive: true, fields: [] },
      "pub const Offset = enum(u32) {\n    _,\n};\n",
    ],
    [
      { name: "Implicit", backing_type: "u16", fields: [{ name: "first", value: 10 }, { name: "next" }, { name: "reset", value: 0 }, { name: "last" }] },
      "pub const Implicit = enum(u16) {\n    first = 10,\n    next,\n    reset = 0,\n    last,\n};\n",
    ],
    [
      { name: "Edges", backing_type: "i32", fields: [{ name: "minimum", value: -2147483648 }, { name: "maximum", value: 2147483647 }] },
      "pub const Edges = enum(i32) {\n    minimum = -2147483648,\n    maximum = 2147483647,\n};\n",
    ],
    [
      { name: "Unsigned", backing_type: "u32", fields: [{ name: "maximum", value: 4294967295 }] },
      "pub const Unsigned = enum(u32) {\n    maximum = 4294967295,\n};\n",
    ],
    [
      { name: "SmallSigned", backing_type: "i8", fields: [{ name: "minimum", value: -128 }, { name: "maximum", value: 127 }] },
      "pub const SmallSigned = enum(i8) {\n    minimum = -128,\n    maximum = 127,\n};\n",
    ],
  ];
  for (const [input, expected] of fixtures) {
    const result = generate(input);
    assert.equal(result.status, 0, JSON.stringify(input));
    assert.equal(result.output, expected);
    assert.equal(result.inspection.compiler_version, "0.17.0");
    const { tokens, nodes } = result.inspection;
    assert.equal(tokens.at(-1).tag, "eof");
    assert.equal(tokens.at(-1).spelling, "");
    assert.equal(nodes[0].tag, "root");
    for (const [index, token] of tokens.entries()) {
      assert.equal(token.index, index);
      assert.equal(typeof token.tag, "string");
      assert.equal(typeof token.spelling, "string");
    }
    for (const [index, node] of nodes.entries()) {
      assert.equal(node.index, index);
      assert(node.main_token >= 0 && node.main_token < tokens.length);
    }
    assert.equal(result.inspection.source, tokens.slice(0, -1).map(token => `${token.spelling} `).join(""));
    assert.equal(nodes.filter(node => node.tag.startsWith("container_field")).length, input.fields.length + (input.non_exhaustive ? 1 : 0));
    assert.equal(nodes.filter(node => node.tag === "negation").length, input.fields.filter(field => field.value < 0).length);
  }
  assert.equal(generate({ name: "Status", backing_type: null, non_exhaustive: false, fields: [{ name: "unknown", value: null }, { name: "ok" }, { name: "warning" }] }).output, fixtures[0][1]);

  function expectError(input, expected) {
    const result = generate(input);
    assert.equal(result.status, 1, JSON.stringify(input));
    if (expected) assert.equal(result.output, expected);
    assert.deepEqual(result.inspection, {});
    assert.equal(generate(fixtures[0][0]).output, fixtures[0][1], "recovery after invalid input");
  }
  for (const name of ["", "enum", "struct", "fn", "_", "u8", "void", "1invalid", "a b", "a\n", "x;const injected=0", "café", '@"escaped"', "x".repeat(65)]) {
    expectError({ name, fields: [{ name: "ok" }] }, "InvalidIdentifier");
    expectError({ name: "Status", fields: [{ name }] }, "InvalidIdentifier");
  }
  const thirtyTwoFields = Array.from({ length: 32 }, (_, index) => ({ name: `field_${index}` }));
  assert.equal(generate({ name: "Full", fields: thirtyTwoFields }).status, 0);
  assert.equal(generate({ name: "x".repeat(64), fields: [{ name: "y".repeat(64) }] }).status, 0);
  expectError({ name: "TooMany", fields: [...thirtyTwoFields, { name: "extra" }] }, "TooManyFields");
  expectError({ name: "Status", fields: [{ name: "ok" }, { name: "ok" }] }, "DuplicateField");
  expectError({ name: "Status", backing_type: "u8", fields: [{ name: "a", value: 1 }, { name: "b", value: 1 }] }, "DuplicateValue");
  expectError({ name: "Status", backing_type: "u8", fields: [{ name: "a" }, { name: "b", value: 0 }] }, "DuplicateValue");
  expectError({ name: "Status", fields: [{ name: "a", value: 1 }] }, "MissingBackingType");
  expectError({ name: "Status", non_exhaustive: true, fields: [] }, "MissingBackingType");
  for (const backing_type of ["u64", "usize", "f32", "i7", "u8;", ""]) {
    expectError({ name: "Status", backing_type, fields: [] }, "UnsupportedBackingType");
  }
  for (const [backing_type, value] of [["u8", -1], ["u8", 256], ["u16", 65536], ["u32", 4294967296], ["i8", -129], ["i8", 128], ["i16", -32769], ["i32", 2147483648], ["i32", -2147483649]]) {
    expectError({ name: "Status", backing_type, fields: [{ name: "outside", value }] }, "ValueOutOfRange");
  }
  expectError({ name: "Status", backing_type: "u8", fields: [{ name: "last", value: 255 }, { name: "overflow" }] }, "ValueOutOfRange");
  for (const value of ['"1"', "1.0", "1e1", "1.5", "true"]) {
    expectError(`{"name":"Status","backing_type":"u8","fields":[{"name":"a","value":${value}}]}`);
  }
  for (const input of ["{", "", "null", "[]", '{"name":"Status"}', '{"name":1,"fields":[]}', '{"name":"Status","fields":[1]}', '{"name":"Status","extra":true,"fields":[]}', '{"name":"Status","fields":[{"name":"a","extra":0}]}', '{"name":"Status","backing_type":"i32","fields":[{"name":"a","value":-9223372036854775808}]}', '{"name":"Status","backing_type":"u32","fields":[{"name":"a","value":9223372036854775808}]}']) {
    expectError(input);
  }
  assert.equal(api.generate(api.inputCapacity() + 1), 2);
  assert.equal(read(api.outputPointer(), api.outputLength()), "InputTooLarge");
  assert.equal(read(api.inspectPointer(), api.inspectLength()), "{}");

  const catalogResults = catalog.map(entry => {
    const result = generate(entry.input);
    assert.equal(result.status, 0, entry.id + ": " + result.output);
    if (entry.expected) assert.equal(result.output, entry.expected, entry.id);
    assert.equal(result.inspection.nodes[0].tag, "root", entry.id);
    for (const node of result.inspection.nodes) assert(result.inspection.tokens[node.main_token], entry.id + " node token link");
    const model = layoutTree(result.inspection);
    assert.deepEqual(model.nodes.map(node => node.index).sort((left, right) => left - right), result.inspection.nodes.map(node => node.index), entry.id + " projected nodes");
    const edges = result.inspection.nodes.flatMap(node => node.children.map(child => `${node.index}:${child}`));
    assert.deepEqual(model.branches.map(edge => `${edge.from}:${edge.to}`).sort(), edges.sort(), entry.id + " projected edges");
    assert.deepEqual(model.leaves.map(node => node.index).sort((left, right) => left - right), result.inspection.nodes.filter(node => !node.children.length).map(node => node.index), entry.id + " terminal leaves");
    for (const node of model.nodes) {
      assert(Number.isFinite(node.x) && Number.isFinite(node.y), entry.id + " finite layout");
      assert(node.x >= 0 && node.x <= 1 && node.y >= 0 && node.y <= 1, entry.id + " bounded layout");
    }
    const state = initialBranches(model);
    assert(model.nodes.some(node => node.index === state.selected), entry.id + " registered initial selection");
    const visible = branchView(result.inspection, state.expanded);
    assert(visible.nodes.some(node => node.index === state.selected), entry.id + " selected node is visible");
    for (const node of visible.nodes.filter(node => node.collapsed)) {
      assert(!visible.leaves.some(leaf => leaf.index === node.index), entry.id + " collapsed branches are not leaves");
    }
    for (const leaf of model.leaves) {
      const parents = nodePath(model, leaf.index);
      assert.equal(parents[0].index, 0, entry.id + " leaf path reaches file root");
      assert.equal(parents.at(-1).index, leaf.index);
      const expanded = new Set([...state.expanded, ...parents.slice(0, -1).map(node => node.index)]);
      const revealed = branchView(result.inspection, expanded);
      assert(revealed.leaves.some(node => node.index === leaf.index), entry.id + " every terminal node can be revealed");
    }
    const lines = tokenLines(result.inspection, result.output);
    assert(lines, entry.id + " formatted source token mapping");
    for (const token of result.inspection.tokens) {
      if (token.tag !== "eof") assert(lines[token.index], entry.id + " mapped token " + token.spelling);
    }
    if (entry.input.name) {
      const renamed = generate({ ...entry.input, name: "RenamedExample" });
      assert.equal(renamed.status, 0, entry.id + " rename");
      assert(renamed.output.includes("RenamedExample"));
    }
    return result;
  });
  const constant = generate({ example: "constant" }).inspection;
  const constantDeclaration = constant.nodes[constant.nodes[0].children[0]];
  assert.equal(constant.nodes[0].children.length, 1);
  assert.equal(constantDeclaration.tag, "simple_var_decl");
  assert.deepEqual(constantDeclaration.children.map(index => constant.tokens[constant.nodes[index].main_token].spelling), ["u32", "42"]);
  assert(constantDeclaration.children.every(index => constant.nodes[index].children.length === 0));

  const configuration = generate({ example: "configuration" }).inspection;
  const spelling = node => configuration.tokens[node.main_token].spelling;
  const declaration = configuration.nodes[configuration.nodes[0].children[0]];
  const structure = configuration.nodes[declaration.children[0]];
  assert.equal(configuration.nodes[0].children.length, 1);
  assert.equal(spelling(structure), "struct");
  assert.deepEqual(structure.children.map(index => spelling(configuration.nodes[index])), ["host", "port", "log_level", "token", "fn"]);
  const recursive = layoutTree(configuration);
  const branchState = initialBranches(recursive);
  const selectedPath = nodePath(recursive, branchState.selected);
  assert.equal(selectedPath.at(-1).label, "info", "initial nested enum member matches its default");
  assert.equal(selectedPath.at(-1).tag, "identifier", "enum member is distinct from the .info initializer");
  assert.equal(selectedPath.at(-2).tag, "container_field_init", "leaf retains its exact field owner");
  const enumNode = selectedPath.find(node => node.label === "enum");
  branchState.expanded.delete(enumNode.index);
  const collapsed = branchView(configuration, branchState.expanded);
  assert(collapsed.nodes.some(node => node.index === enumNode.index && node.collapsed));
  assert(!collapsed.nodes.some(node => node.index === branchState.selected), "collapsing hides all descendant controls");
  branchState.expanded.add(enumNode.index);
  assert(branchView(configuration, branchState.expanded).leaves.some(node => node.index === branchState.selected), "expansion restores the registered leaf");
  const port = configuration.nodes[structure.children[1]];
  assert.deepEqual(port.children.map(index => spelling(configuration.nodes[index])), ["u16", "8080"]);
  const level = configuration.nodes[structure.children[2]];
  const enumeration = configuration.nodes[level.children[0]];
  assert.deepEqual(enumeration.children.map(index => spelling(configuration.nodes[index])), ["quiet", "info", "debug"]);
  const method = configuration.nodes[structure.children[4]];
  assert.deepEqual(method.children.map(index => configuration.nodes[index].tag), ["fn_proto_simple", "block_two_semicolon"]);
  const body = configuration.nodes[method.children[1]];
  const returned = configuration.nodes[body.children[0]];
  assert.equal(returned.tag, "return");
  const access = configuration.nodes[returned.children[0]];
  assert.equal(access.tag, "field_access");
  assert.deepEqual(access.children.map(index => spelling(configuration.nodes[index])), ["self"]);
  expectError({ example: "missing" }, "UnknownExample");
  expectError({ example: "constant", extra: true }, "UnknownField");
  expectError({ example: "constant", name: "bad name" }, "InvalidIdentifier");
  expectError({ example: "constant", schema: {} }, "UnknownField");
  expectError({ example: "flatbuf-json" }, "MissingField");
  expectError({ example: "flatbuf-json", schema: { objects: [{ name: "Bad", fields: [{ name: "bad", type: { base_type: "String" } }] }] } }, "UnsupportedSchema");
  const schemaEdit = generate({example:"json-schema",schema:{objects:[{name:"EditedReading",fields:[{name:"value",type:{base_type:"UInt"},default_integer:123}]}]}});
  assert.equal(schemaEdit.status, 0);
  assert(schemaEdit.output.includes("value: u32 = 123"));

  // Warm the largest accepted shape before checking allocator reuse. Wasm memory
  // cannot shrink; repeated generation must stop requesting additional pages.
  const largest = { name: "Stress", backing_type: "i32", fields: thirtyTwoFields.map((field, index) => ({ ...field, value: -100 + index })) };
  assert.equal(generate(largest).status, 0);
  const memoryBytes = api.memory.buffer.byteLength;
  for (let iteration = 0; iteration < 500; iteration++) {
    assert.equal(generate(iteration % 2 ? largest : catalog[iteration % catalog.length].input).status, 0);
    expectError("{", undefined);
  }
  assert.equal(api.memory.buffer.byteLength, memoryBytes);

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "zast-playground-test-"));
  try {
    fs.copyFileSync(path.join(__dirname, "generated.zig"), path.join(temporaryDirectory, "main.zig"));
    fs.writeFileSync(path.join(temporaryDirectory, "generated-output.zig"), fixtures.map(([, output]) => output).join(""));
    childProcess.execFileSync(process.env.ZIG || "zig", ["test", path.join(temporaryDirectory, "main.zig")], {
      stdio: "inherit",
      env: {
        ...process.env,
        ZIG_GLOBAL_CACHE_DIR: process.env.ZIG_GLOBAL_CACHE_DIR || path.join(os.tmpdir(), "zast-playground-global-cache"),
        ZIG_LOCAL_CACHE_DIR: process.env.ZIG_LOCAL_CACHE_DIR || path.join(os.tmpdir(), "zast-playground-local-cache"),
      },
    });
    const semantic = {
      constant: 'try std.testing.expectEqual(@as(u32,42), generated.answer);',
      types: 'try std.testing.expect(generated.OptionalText == ?[]const u8);',
      enum: 'try std.testing.expectEqualStrings("ok", @tagName(generated.Status.ok));',
      union: 'const value: generated.Payload = .{ .number = 42 }; try std.testing.expectEqual(@as(u32,42),value.number);',
      function: 'try std.testing.expectEqual(@as(u32,19),generated.identity(19));',
      struct: 'const value: generated.Reading = .{}; try std.testing.expectEqual(@as(u32,42),value.get());',
      nested: 'const value: generated.Response = .{}; try std.testing.expectEqualStrings("unknown",@tagName(value.status));',
      builtin: 'try std.testing.expectEqual(@as(usize,4),generated.scalar_size);',
      initializer: 'try std.testing.expect(generated.options.required);',
      comments: 'try std.testing.expectEqual(@as(u32,42),generated.answer);',
      callback: 'const callback: generated.Callback = identity; try std.testing.expectEqual(@as(u32,7),callback(7));',
      blocks: 'generated.noop();',
      comptime: 'try std.testing.expectEqual(@as(u32,42),try generated.forward(u32,42)); try std.testing.expectError(error.TestFailure,generated.forward(u32,error.TestFailure));',
      "json-schema": 'try std.testing.expectEqual(@as(u32,84),generated.Reading.answerFunc()); const value: generated.Reading = .{}; try std.testing.expectEqual(@as(u32,65),value.answer);',
      "flatbuf-json": 'const value: generated.Reading = .{}; try std.testing.expectEqual(@as(u32,65),value.answer); try std.testing.expectEqual(@as(u8,2),@backingInt(generated.Status.Warning));',
      protocol: 'try std.testing.expectEqual(@as(usize,1),@sizeOf(generated.Flags)); const packet: generated.Packet = .{.sequence=1,.payload=.{.data="abc"}}; try std.testing.expectEqualStrings("abc",packet.payload.data);',
      configuration: 'const configuration: generated.Configuration = .{}; try std.testing.expectEqualStrings("localhost",configuration.hostname()); try std.testing.expectEqual(@as(u16,8080),configuration.port);',
      "generic-storage": 'const Storage = generated.Storage(u16); const values = [_]u16{1,2,3}; const storage: Storage = .{.items=&values}; try std.testing.expectEqualSlices(u16,&values,storage.view());',
    };
    let nativeTests = 'const std = @import("std");\nfn identity(value:u32)u32{return value;}\n';
    for (const [index, entry] of catalog.entries()) {
      fs.writeFileSync(path.join(temporaryDirectory, "output-" + entry.id + ".zig"), catalogResults[index].output);
      fs.writeFileSync(path.join(temporaryDirectory, "builder-" + entry.id + ".zig"), buildApiSource(entry.input));
      nativeTests += 'test "catalog ' + entry.id + '" {\n' +
        ' const generated = @import("output-' + entry.id + '.zig");\n' +
        ' const expected = @embedFile("output-' + entry.id + '.zig");\n' +
        ' var parsed = try std.zig.Ast.parse(std.testing.allocator,expected,.{}); defer parsed.deinit(std.testing.allocator);\n' +
        ' try std.testing.expectEqual(@as(usize,0),parsed.errors.len);\n' +
        ' const actual = try @import("builder-' + entry.id + '.zig").generate(std.testing.allocator); defer std.testing.allocator.free(actual);\n' +
        ' try std.testing.expectEqualStrings(expected,actual);\n' +
        (semantic[entry.id] || 'std.testing.refAllDecls(generated);') + '\n}\n';
    }
    const nativeFile = path.join(temporaryDirectory,"catalog-tests.zig");
    fs.writeFileSync(nativeFile, nativeTests);
    childProcess.execFileSync(process.env.ZIG || "zig", ["test","--dep","zast","-Mroot="+nativeFile,"-Mzast="+path.resolve(process.env.ZAST_DIR || path.join(siteDirectory,"../zast"),"src/root.zig")], {stdio:"inherit",env:process.env});
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ wasmBytes: wasmBytes.length, imports: 0, fixtureCount: fixtures.length, catalogEntries: catalog.length, nativeBuilders: catalog.length, repeatedGenerations: 500, memoryBytes, checks: "exact rendering, strict validation, AST edges/token spans/tree projection, recovery, bounded memory, native semantic compilation" }));
}

main().catch(failure => { console.error(failure); process.exitCode = 1; });
