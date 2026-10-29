import { catalog } from "./catalog.js";
export { catalog };
export const examples = Object.fromEntries(catalog.map(entry => [entry.id, entry]));

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

export function buildApiSource(description, standalone = true) {
  const entry = examples[description.example];
  const body = description.schema ? schemaBody(description) : entry
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
    title: entry?.title || "Custom enum",
    filename: (description.name || entry?.name || "schema") + ".zig",
    description: entry?.description || (entry?.number
      ? "README example " + entry.number + (compact ? ". Open the playground to customize this example." : ". Edit name to rename its generated declaration.")
      : "Edit the enum description to explore its fields and backing type."),
  };
}
