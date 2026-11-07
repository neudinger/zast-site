const assert = require("node:assert/strict");

// Exercise data edits rather than recipe selection. Returned cases are also
// compiled by the caller to compare the equivalent builder with the Wasm output.
function checkDescriptions({ catalog, generate, buildApiSource }) {
  const entries = Object.fromEntries(catalog.map(entry => [entry.id, entry]));
  const edited = [];
  const identifier = name => ({ identifier: name });
  const integer = value => ({ integer_literal: String(value) });
  const clone = value => JSON.parse(JSON.stringify(value));
  function check(id, input, expected, absent = []) {
    const result = generate(input);
    assert.equal(result.status, 0, id + ": " + result.output);
    for (const snippet of expected) assert(result.output.includes(snippet), id + ": missing " + snippet);
    for (const snippet of absent) assert(!result.output.includes(snippet), id + ": retained " + snippet);
    const builder = buildApiSource(input);
    assert(builder.includes('const zast = @import("zast");'), id + ": complete builder");
    edited.push({ id, input, output: result.output });
    return result;
  }
  function edit(id, change, expected, absent) {
    const input = clone(entries[id].input);
    change(input);
    return check(id, input, expected, absent);
  }

  assert.equal(catalog.filter(entry => entry.input.declarations).length, 17);
  for (const entry of catalog) {
    assert(Buffer.byteLength(JSON.stringify(entry.input, null, 2)) <= 4096, entry.id + ": editable input fits");
    assert.equal(generate(entry.input).status, 0, entry.id + ": complete description");
  }

  edit("constant", input => {
    input.declarations[0].declaration.type_expression = identifier("u16");
    input.declarations[0].declaration.value = integer(73);
  }, ["pub const answer: u16 = 73;"]);
  edit("types", input => {
    const slice = input.declarations[0].declaration.value.optional_type.slice_type;
    slice.child_type = identifier("u16");
    slice.is_const = false;
  }, ["pub const OptionalText = ?[]u16;"]);
  edit("enum", input => {
    input.declarations[0].declaration.value.enum_type.fields.push({ name: "paused" });
  }, ["    paused,"]);
  edit("union", input => {
    const fields = input.declarations[0].declaration.value.union_type.fields;
    fields.pop();
    fields.push({ name: "floating", type_expression: identifier("f64") });
  }, ["    floating: f64,"], ["boolean: bool"]);
  edit("function", input => {
    const declaration = input.declarations[0].function;
    declaration.parameters = [
      { name: "count", type_expression: identifier("u16") },
      { name: "_", type_expression: identifier("u8") },
    ];
    declaration.return_type = identifier("u16");
    declaration.body.statements = [{ return_value: identifier("count") }];
  }, ["pub fn identity(count: u16, _: u8) u16 {", "    return count;"]);
  edit("struct", input => {
    const members = input.declarations[0].declaration.value.struct_type.members;
    members[0].field.value = integer(7);
    const getter = members[1].function.declaration;
    getter.parameters[0].name = "_";
    getter.body.statements[0].return_value = integer(7);
  }, ["value: u32 = 7,", "pub fn get(_: *const @This()) u32 {", "return 7;"]);
  edit("nested", input => {
    const field = input.declarations[0].declaration.value.struct_type.members[0].field;
    field.type_expression.enum_type.fields.push({ name: "retry" });
    field.value = { enum_literal: "retry" };
  }, ["        retry,", "    } = .retry,"]);
  edit("builtin", input => {
    input.declarations[0].declaration.value.builtin_call.arguments[0] = identifier("u16");
  }, ["pub const scalar_size = @sizeOf(u16);"]);
  edit("initializer", input => {
    input.declarations[0].declaration.value.struct_init.fields[0].value = identifier("false");
  }, ["    .required = false,"]);
  edit("comments", input => {
    input.comment = "Edited generation notice.";
    input.container_doc_comment = "Edited module documentation.";
    input.declarations[0].doc_comment = "The edited answer.";
    input.declarations[0].declaration.value = integer(73);
  }, ["// Edited generation notice.", "//! Edited module documentation.", "/// The edited answer.", "answer: u32 = 73;"]);
  edit("callback", input => {
    const signature = input.declarations[0].declaration.value.pointer_type.child_type.function_type;
    signature.parameters[0].type_expression = identifier("u16");
    signature.return_type = identifier("u16");
  }, ["pub const Callback = *const fn (u16) u16;"]);
  edit("blocks", input => {
    const declaration = input.declarations[0].function.body.statements[0].block.statements[0].declaration.declaration;
    declaration.type_expression = identifier("u16");
    declaration.value = integer(17);
  }, ["        const value: u16 = 17;"]);
  edit("comptime", input => {
    input.declarations[0].function.body.statements.unshift(
      { declaration: { name: "offset", declaration: { type_expression: identifier("u32"), value: integer(7) } } },
      { assignment: { target: identifier("_"), value: identifier("offset") } },
    );
  }, ["    const offset: u32 = 7;", "    _ = offset;"]);
  edit("json-schema", input => {
    const members = input.declarations[0].declaration.value.struct_type.members;
    members[0].field.value = integer(123);
    members[1].function.declaration.body.statements[0].return_value = integer(99);
  }, ["answer: u32 = 123,", "return 99;"], ["return 84;"]);
  edit("protocol", input => {
    const members = input.declarations[1].declaration.value.struct_type.members;
    members[2].field.type_expression = identifier("u5");
    members.push({ field: { name: "acknowledged", type_expression: identifier("bool"), value: identifier("false") } });
    input.declarations[3].declaration.value.struct_type.members[0].field.type_expression = identifier("u64");
  }, ["reserved: u5 = 0,", "acknowledged: bool = false,", "sequence: u64,"]);
  edit("configuration", input => {
    const members = input.declarations[0].declaration.value.struct_type.members;
    members[0].field.value = { string_literal: '"remote.test"' };
    members[1].field.value = integer(9090);
    members[2].field.value = { enum_literal: "debug" };
    members.splice(3, 1);
  }, ['host: []const u8 = "remote.test",', "port: u16 = 9090,", "    } = .debug,"], ["token: ?[]const u8"]);
  edit("generic-storage", input => {
    const members = input.declarations[0].function.body.statements[0].return_value.struct_type.members;
    members[0].field.type_expression.slice_type.is_const = false;
    members[1].function.declaration.return_type.slice_type.is_const = false;
  }, ["items: []Item,", "pub fn view(self: *const @This()) []Item {"]);
  edit("flatbuf-json", input => {
    input.schema.objects[0].fields[0].default_integer = 22;
    input.schema.objects[0].fields.push({ name: "count", type: { base_type: "UInt" }, default_integer: 3 });
    input.schema.enums[0].values.push({ name: "Busy", value: 3 });
  }, ["answer: u32 = 22,", "count: u32 = 3,", "    Busy = 3,"]);

  for (const id of ["basic", "status", "inferred", "signed", "offset", "empty"]) {
    edit(id, input => { input.fields.push({ name: "extra" }); }, ["    extra,"]);
  }
  assert.equal(edited.length, 24, "every catalogue input has a meaningful edit");

  const custom = clone(entries.constant.input);
  delete custom.example;
  custom.declarations[0].name = "CustomValue";
  custom.declarations[0].declaration.value = integer(91);
  check("custom-without-example", custom, ["pub const CustomValue: u32 = 91;"]);
  const escaped = clone(custom);
  escaped.declarations[0].name = '@"display-name"';
  check("escaped-identifier", escaped, ['pub const @"display-name": u32 = 91;']);
  edit("enum", input => {
    input.declarations[0].declaration.value.enum_type.fields.shift();
  }, ["    ok,"], ["    unknown,"]);
  edit("function", input => {
    const declaration = input.declarations[0].function;
    declaration.parameters = [];
    declaration.body.statements[0].return_value = integer(8);
  }, ["pub fn identity() u32 {", "    return 8;"]);

  const unitForms = { declarations: [
    { name: "Single", declaration: { value: { pointer_type: { child_type: identifier("u8"), kind: { single: null } } } } },
    { name: "CBytes", declaration: { value: { pointer_type: { child_type: identifier("u8"), kind: { c: {} } } } } },
    { name: "Tagged", declaration: { value: { union_type: { tag_type: { inferred: null }, fields: [{ name: "none" }] } } } },
    { name: "Untagged", declaration: { value: { union_type: { tag_type: { untagged: {} }, fields: [{ name: "value", type_expression: identifier("u8") }] } } } },
  ] };
  check("unit-union-forms", unitForms, ["pub const Single = *u8;", "pub const CBytes = [*c]u8;", "pub const Tagged = union(enum)", "pub const Untagged = union {"]);

  // Saved recipes retain their original defaults and root-name override.
  for (const entry of catalog.filter(entry => entry.number <= 13 || entry.group === "Composed showcases")) {
    const legacy = generate({ example: entry.id });
    assert.equal(legacy.status, 0, entry.id + ": legacy recipe");
    assert.equal(legacy.output, entry.expected, entry.id + ": legacy output");
    const renamed = generate({ example: entry.id, name: "LegacyRenamed" });
    assert.equal(renamed.status, 0, entry.id + ": legacy rename");
    assert(renamed.output.includes("LegacyRenamed"));
    assert(buildApiSource({ example: entry.id, name: "LegacyRenamed" }, false).includes("LegacyRenamed"));
  }
  const legacySchema = generate({
    example: "json-schema",
    schema: { objects: [{ name: "LegacyReading", fields: [{ name: "answer", type: { base_type: "UInt" }, default_integer: 65 }] }] },
  });
  assert.equal(legacySchema.status, 0);
  assert(legacySchema.output.includes("pub const LegacyReading = struct {"));
  assert(legacySchema.output.includes("return 84;"));

  function reject(input, expected) {
    const result = generate(input);
    assert.equal(result.status, 1, "invalid descriptor: " + JSON.stringify(input));
    if (expected) assert.equal(result.output, expected);
    assert.deepEqual(result.inspection, {});
    assert.equal(generate(entries.constant.input).output, entries.constant.expected, "recovery after descriptor error");
  }
  function invalid(change, expected) {
    const input = clone(entries.constant.input);
    change(input);
    reject(input, expected);
  }
  invalid(input => { input.unknown = true; });
  invalid(input => { input.declarations[0].declaration.unknown = true; });
  invalid(input => { input.declarations = {}; });
  invalid(input => { input.declarations[0].name = 42; });
  invalid(input => { input.declarations[0].visibility = "export"; });
  invalid(input => {
    input.declarations[0].declaration.value = { pointer_type: { child_type: identifier("u8"), kind: "many" } };
  });
  invalid(input => { input.declarations[0].declaration.value = { integer_literal: 42 }; });
  invalid(input => { input.declarations[0].declaration.value = { identifier: "u8", integer_literal: "42" }; });
  invalid(input => { input.declarations[0].declaration.value = { unsupported_expression: {} }; });
  invalid(input => { input.declarations[0].declaration.value = { type_description: {} }; });
  invalid(input => { input.declarations[0].function = {}; }, "InvalidDeclaration");
  invalid(input => { delete input.declarations[0].declaration; }, "InvalidDeclaration");
  for (const spelling of ["bad name", "x; const injected = 1", "", "u8\nconst injected = 1"]) {
    invalid(input => { input.declarations[0].name = spelling; });
  }
  for (const expression of [
    { identifier: "u8; const injected = 1" },
    { integer_literal: "42; const injected = 1" },
    { integer_literal: "1.5" },
    { integer_literal: "1invalid" },
    { string_literal: '"ok"; const injected = 1' },
    { string_literal: '"unterminated' },
    { builtin_call: { name: "@This(); const injected = 1" } },
  ]) invalid(input => { input.declarations[0].declaration.value = expression; });
  invalid(input => {
    let expression = integer(1);
    for (let depth = 0; depth < 100; depth++) expression = { grouped: expression };
    input.declarations[0].declaration.value = expression;
  }, "DescriptionTooDeep");
  invalid(input => {
    input.declarations[0].declaration.value = { enum_type: {
      backing_type: null,
      fields: Array.from({ length: 129 }, (_, index) => ({ name: "field_" + index })),
    } };
  }, "TooManyItems");
  return edited;
}

module.exports = { checkDescriptions };
