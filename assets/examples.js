import { catalog } from "./catalog.js";
export { catalog };
export const examples = Object.assign(Object.create(null), Object.fromEntries(catalog.map(entry => [entry.id, entry])));

function zigString(value) {
  return '"' + String(value).replace(/[\\"\x00-\x1f\x7f]/g, character => ({
    '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t',
  })[character] || "\\x" + character.charCodeAt(0).toString(16).padStart(2, "0")) + '"';
}

// The small schema lesson escapes names using std.zig.fmtId in Wasm.
const keywords = new Set("addrspace align allowzero and anyframe anytype asm async await break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline nosuspend opaque or orelse packed pub resume return section callconv struct suspend switch test threadlocal try union unreachable var volatile while".split(" "));
const identifier = name => /^[A-Za-z_][A-Za-z_0-9]*$/.test(name) && !keywords.has(name) ? name : "@" + zigString(name);
const named = name => zigString(identifier(name));

function enumBody(description, binding = "declaration", escapeNames = false) {
  const quoteName = escapeNames ? named : zigString;
  return [
    "const " + binding + ": zast.EnumDeclaration = .{",
    "    .backing_type = " + (description.backing_type == null ? "null" : zigString(description.backing_type)) + ",",
    "    .non_exhaustive = " + Boolean(description.non_exhaustive) + ",",
    "    .fields = &.{",
    ...description.fields.map(field => {
      const value = field.value;
      const expression = value == null ? "" : value < 0
        ? ', .value = .{ .negate = &zast.Expression{ .integer_literal = "' + Math.abs(value) + '" } }'
        : ', .value = .{ .integer_literal = "' + value + '" }';
      return "        .{ .name = " + quoteName(field.name) + expression + " },";
    }),
    "    },",
    "};",
    "try " + binding + ".emit(allocator, context, " + quoteName(description.name) + ", .public);",
  ].join("\n");
}

function schemaBody(description) {
  const schema = description.schema;
  const fragments = (schema.enums || []).map((entry, index) => enumBody({
    name: entry.name, backing_type: "u8", non_exhaustive: true, fields: entry.values,
  }, "enumeration_" + index, true));
  const withMethod = description.example === "json-schema";
  if (withMethod && schema.objects?.length) fragments.push([
    "const method: zast.FunctionDeclaration = .{",
    '    .return_type = .{ .identifier = "u32" },',
    '    .body = .{ .statements = &.{.{ .return_value = .{ .integer_literal = "84" } }} },',
    "};",
  ].join("\n"));
  for (const [index, object] of (schema.objects || []).entries()) {
    fragments.push([
      "const object_" + index + ": zast.StructDeclaration = .{ .members = &.{",
      ...object.fields.map(field => [
        "    .{ .field = .{",
        "        .name = " + named(field.name) + ",",
        '        .type_expression = .{ .identifier = "u32" },',
        '        .value = .{ .integer_literal = "' + (field.default_integer ?? 0) + '" },',
        "    } },",
      ].join("\n")),
      ...(withMethod ? ['    .{ .function = .{ .name = "answerFunc", .declaration = &method, .visibility = .public } },'] : []),
      "} };",
      "try object_" + index + ".emit(allocator, context, " + named(object.name) + ", .public);",
    ].join("\n"));
  }
  return fragments.join("\n\n");
}

// The JSON adapter mirrors zast's descriptors. These schemas restore Zig-only
// syntax (borrowed pointers, slices, enum tags and anonymous type adapters).
const qualifiers = {
  child_type: "*expression", is_const: "boolean", is_volatile: "boolean",
  is_allowzero: "boolean", alignment: "?*expression",
};
const descriptorSchemas = {
  declaration: { kind: "tag", type_expression: "?expression", value: "expression" },
  function: { parameters: "[]parameter", return_type: "expression", body: "block" },
  parameter: { name: "?string", type_expression: "expression", is_comptime: "boolean" },
  field: { name: "string", type_expression: "?expression", value: "?expression" },
  enum: { backing_type: "?string", non_exhaustive: "boolean", fields: "[]field" },
  union: { tag_type: "tag_type", fields: "[]field" },
  struct: { layout: "tag", members: "[]member" },
  block: { statements: "[]statement" },
  initializer_field: { name: "string", value: "expression" },
  member: {
    field: "field",
    function: { name: "string", declaration: "*function", visibility: "tag" },
    declaration: { name: "string", declaration: "declaration", visibility: "tag" },
  },
  statement: {
    expression: "expression",
    declaration: { name: "string", declaration: "declaration" },
    assignment: { target: "expression", value: "expression" },
    return_value: "?expression", block: "*block",
  },
  tag_type: { untagged: "void", inferred: "void", backing_type: "expression", enum_type: "expression" },
  pointer_kind: { single: "void", c: "void", many: "?*expression" },
  expression: {
    integer_literal: "string", string_literal: "string", char_literal: "string",
    identifier: "string", enum_literal: "string",
    negate: "*expression", address_of: "*expression", try: "*expression",
    optional_type: "*expression", grouped: "*expression",
    array_type: { length: "*expression", child_type: "*expression", sentinel: "?*expression" },
    pointer_type: { ...qualifiers, kind: "pointer_kind" },
    slice_type: { ...qualifiers, sentinel: "?*expression" },
    error_set_type: "[]string",
    error_union_type: { error_set: "*expression", payload_type: "*expression" },
    shift_left: { left: "*expression", right: "*expression" },
    field_access: { base: "*expression", name: "string" },
    struct_init: {
      type_expression: "?*expression", fields: "[]initializer_field", trailing_comma: "boolean",
    },
    array_init: { type_expression: "?*expression", elements: "[]expression", trailing_comma: "boolean" },
    call: { callee: "*expression", arguments: "[]expression" },
    builtin_call: { name: "string", arguments: "[]expression" },
  },
};
const descriptorNames = {
  declaration: "zast.Declaration", function: "zast.FunctionDeclaration", expression: "zast.Expression",
  enum: "zast.EnumDeclaration", union: "zast.UnionDeclaration", struct: "zast.StructDeclaration",
  block: "zast.Block",
};
const typeDescriptors = {
  enum_type: "enum", union_type: "union", struct_type: "struct", function_type: "function",
};
const indent = text => text.split("\n").map(line => "    " + line).join("\n");

function descriptorLiteral(value, schema, typed = false) {
  if (schema === "void") return "{}";
  if (value == null) return "null";
  if (typeof schema === "string") {
    if (schema.startsWith("?")) return descriptorLiteral(value, schema.slice(1), typed);
    if (schema.startsWith("*")) return "&" + descriptorLiteral(value, schema.slice(1), true);
    if (schema.startsWith("[]")) {
      return value.length ? "&.{\n" + value.map(item =>
        indent(descriptorLiteral(item, schema.slice(2)) + ",")).join("\n") + "\n}" : "&.{}";
    }
    if (schema === "string") return zigString(value);
    if (schema === "boolean") return String(value);
    if (schema === "tag" || typeof value === "string") return "." + identifier(value);
    if (schema === "expression") {
      const entries = Object.entries(value);
      if (entries.length === 1 && typeDescriptors[entries[0][0]]) {
        const kind = typeDescriptors[entries[0][0]];
        return "zast.Expression.fromType(&" + descriptorLiteral(entries[0][1], kind, true) + ")";
      }
    }
  }
  const fields = typeof schema === "string" ? descriptorSchemas[schema] : schema;
  if (!fields) throw new Error("Unsupported descriptor: " + schema);
  const prefix = typed ? descriptorNames[schema] : ".";
  const assignments = Object.entries(value).map(([name, field]) => {
    if (!(name in fields)) throw new Error("Unknown descriptor field: " + name);
    return "." + identifier(name) + " = " + descriptorLiteral(field, fields[name]) + ",";
  });
  return assignments.length ? prefix + "{\n" + assignments.map(indent).join("\n") + "\n}"
    : prefix + "{}";
}

function commentSource(text, prefix, token) {
  return text.split("\n").flatMap(line => token ? [
    "_ = try context.token(allocator, ." + token + ", " + zigString(prefix + line) + ");",
    "try context.source.append(allocator, '\\n');",
  ] : ["try context.source.appendSlice(allocator, " + zigString(prefix + line + "\n") + ");"]);
}

function descriptionBody(description) {
  const lines = [];
  if (description.comment != null) lines.push(...commentSource(description.comment, "// "));
  if (description.container_doc_comment != null) {
    lines.push(...commentSource(description.container_doc_comment, "//! ", "container_doc_comment"));
  }
  for (const [index, namedDeclaration] of description.declarations.entries()) {
    if (namedDeclaration.doc_comment != null) {
      lines.push(...commentSource(namedDeclaration.doc_comment, "/// ", "doc_comment"));
    }
    const kind = namedDeclaration.function != null ? "function" : "declaration";
    const binding = "declaration_" + index;
    lines.push(
      "const " + binding + ": " + descriptorNames[kind] + " = " +
        descriptorLiteral(namedDeclaration[kind], kind) + ";",
      "try " + binding + ".emit(allocator, context, " + zigString(namedDeclaration.name) +
        ", ." + (namedDeclaration.visibility ?? "public") + ");",
      "",
    );
  }
  return lines.join("\n");
}

export function buildApiSource(description, standalone = true) {
  const entry = examples[description.example];
  const body = !standalone && entry?.body
    ? entry.body.replace(/\boutput_name\b/g, zigString(description.name ?? entry.name))
    : description.declarations ? descriptionBody(description)
    : description.schema ? schemaBody(description) : entry?.body
    ? entry.body.replace(/\boutput_name\b/g, zigString(description.name ?? entry.name))
    : enumBody(description);
  if (!standalone) return "// allocator + initialized context: *zast.AstContext\n" + body + "\n";
  return [
    'const std = @import("std");',
    'const zast = @import("zast");',
    "",
    "// The caller owns the returned formatted source.",
    "pub fn generate(allocator: std.mem.Allocator) ![]u8 {",
    "    var ast_context: zast.AstContext = .{};",
    "    defer ast_context.deinit(allocator);",
    "    const context = &ast_context;",
    "    _ = try context.addNode(allocator, .root, 0, undefined);",
    "",
    ...body.trimEnd().split("\n").map(line => line ? "    " + line : ""),
    "",
    "    var tree = try context.finish(allocator);",
    "    const source = tree.source;",
    "    defer allocator.free(source);",
    "    defer tree.deinit(allocator);",
    "    return tree.renderAlloc(allocator);",
    "}",
    "",
  ].join("\n");
}

export function exampleInfo(description, compact = false) {
  const entry = examples[description.example] || catalog.find(candidate =>
    !candidate.input.example && JSON.stringify(candidate.input) === JSON.stringify(description));
  return {
    entry,
    title: entry?.title || (description.declarations ? "Custom declarations" : "Custom enum"),
    filename: (description.name || description.declarations?.at(-1)?.name || entry?.name || "schema") + ".zig",
    description: entry?.description || (entry?.number
      ? "README example " + entry.number + (compact
        ? ". Open the playground to customize this example."
        : description.declarations
        ? ". Edit declarations, types, values, parameters, and statements."
        : ". This saved recipe customizes only the declaration name.")
      : description.declarations
      ? "Edit declarations, types, values, parameters, and statements."
      : "Edit the enum description to explore its fields and backing type."),
  };
}
