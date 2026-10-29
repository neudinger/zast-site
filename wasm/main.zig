//! Browser-local bridge for bounded enum descriptions and documented recipes.
//! Returned pointers remain valid until the next `generate` call.
const std = @import("std");
const Ast = std.zig.Ast;
const zast = @import("zast");
const GuideExamples = @import("GuideExamples.zig");
const SchemaExamples = @import("SchemaExamples.zig");
const Recipe = struct {
    example: []const u8,
    name: ?[]const u8 = null,
    schema: ?std.json.Value = null,
};

const Schema = struct {
    name: []const u8,
    backing_type: ?[]const u8 = null,
    non_exhaustive: bool = false,
    fields: []const struct { name: []const u8, value: ?JsonInteger = null },
};
// std.json normally coerces numeric strings and integral floats into integers.
// The public schema accepts JSON integer tokens only.
const JsonInteger = @import("JsonInteger.zig").JsonInteger;

const Bounds = struct { minimum: i64, maximum: i64 };
const InspectedToken = struct { index: u32, tag: []const u8, spelling: []const u8 };
const InspectedNode = struct {
    index: u32,
    tag: []const u8,
    main_token: u32,
    first_token: u32,
    last_token: u32,
    children: []const u32,
};

var input_buffer: [4096]u8 = @splat(0);
var arena = std.heap.ArenaAllocator.init(std.heap.wasm_allocator);
var rendered_output: []const u8 = "";
var inspected_output: []const u8 = "{}";

export fn inputPointer() usize {
    return @intFromPtr(&input_buffer);
}

export fn inputCapacity() usize {
    return input_buffer.len;
}

export fn outputPointer() usize {
    return @intFromPtr(rendered_output.ptr);
}

export fn outputLength() usize {
    return rendered_output.len;
}

export fn inspectPointer() usize {
    return @intFromPtr(inspected_output.ptr);
}

export fn inspectLength() usize {
    return inspected_output.len;
}

/// Return zero on success, one for invalid input/allocation failure, or two for
/// an input larger than the fixed buffer. Errors are returned as output text.
export fn generate(input_length: usize) u32 {
    _ = arena.reset(.free_all);
    rendered_output = "";
    inspected_output = "{}";
    if (input_length > input_buffer.len) {
        rendered_output = "InputTooLarge";
        return 2;
    }
    render(input_buffer[0..input_length]) catch |failure| {
        rendered_output = @errorName(failure);
        return 1;
    };
    return 0;
}

fn validateName(name: []const u8) !void {
    if (name.len > 64 or !std.zig.isValidId(name) or
        std.zig.isUnderscore(name) or std.zig.isPrimitive(name))
        return error.InvalidIdentifier;
}

fn backingBounds(spelling: []const u8) !Bounds {
    inline for (.{ u8, u16, u32, i8, i16, i32 }) |Integer| {
        if (std.mem.eql(u8, spelling, @typeName(Integer))) return .{
            .minimum = std.math.minInt(Integer),
            .maximum = std.math.maxInt(Integer),
        };
    }
    return error.UnsupportedBackingType;
}

/// Validate before allocating AST storage. Effective tag values include implicit
/// successors, so mixed explicit/implicit fields cannot produce invalid Zig.
fn validate(schema: Schema) !void {
    try validateName(schema.name);
    if (schema.fields.len > 32) return error.TooManyFields;
    const bounds = if (schema.backing_type) |spelling| try backingBounds(spelling) else null;
    if (bounds == null and schema.non_exhaustive) return error.MissingBackingType;

    var effective_values: [32]i64 = @splat(0);
    var next_value: i64 = 0;
    for (schema.fields, 0..) |field, field_index| {
        try validateName(field.name);
        for (schema.fields[0..field_index]) |previous_field| {
            if (std.mem.eql(u8, field.name, previous_field.name)) return error.DuplicateField;
        }
        if (bounds == null and field.value != null) return error.MissingBackingType;
        const value = if (field.value) |integer| integer.value else next_value;
        if (bounds) |range| {
            if (value < range.minimum or value > range.maximum) return error.ValueOutOfRange;
        }
        for (effective_values[0..field_index]) |previous_value| {
            if (value == previous_value) return error.DuplicateValue;
        }
        effective_values[field_index] = value;
        next_value = value + 1; // Supported backing integers are at most 32 bits.
    }
    // At most 32 names leave unnamed values in every supported backing type.
}

fn render(input: []const u8) !void {
    const allocator = arena.allocator();
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, input, .{ .parse_numbers = false });
    var context: zast.AstContext = .{};
    _ = try context.addNode(allocator, .root, 0, undefined);
    if (parsed.value == .object and parsed.value.object.contains("example")) {
        const recipe = try std.json.parseFromValue(Recipe, allocator, parsed.value, .{});
        if (recipe.value.name) |name| try validateName(name);
        if (std.meta.stringToEnum(GuideExamples.Kind, recipe.value.example)) |kind| {
            if (recipe.value.schema != null) return error.UnknownField;
            try GuideExamples.emit(kind, allocator, &context, recipe.value.name);
        } else if (std.mem.eql(u8, recipe.value.example, "json-schema") or
            std.mem.eql(u8, recipe.value.example, "flatbuf-json"))
        {
            if (recipe.value.name != null) return error.UnknownField;
            try SchemaExamples.emit(allocator, &context, recipe.value.schema orelse return error.MissingField, std.mem.eql(u8, recipe.value.example, "json-schema"));
        } else {
            if (recipe.value.schema != null) return error.UnknownField;
            inline for (.{
                .{ "protocol", "Packet", @import("showcase/protocol.zig") },
                .{ "configuration", "Configuration", @import("showcase/configuration.zig") },
                .{ "generic-storage", "Storage", @import("showcase/generic-storage.zig") },
            }) |entry| {
                if (std.mem.eql(u8, recipe.value.example, entry[0])) {
                    try entry[2].emit(allocator, &context, recipe.value.name orelse entry[1]);
                    break;
                }
            } else return error.UnknownExample;
        }
    } else {
        const schema = try std.json.parseFromValue(Schema, allocator, parsed.value, .{});
        try emitEnum(allocator, &context, schema.value);
    }
    const tree = try context.finish(allocator);
    const formatted = try tree.renderAlloc(allocator);

    const tokens = try allocator.alloc(InspectedToken, tree.tokens.len);
    for (tokens, 0..) |*token, token_index| {
        const index: u32 = @intCast(token_index);
        token.* = .{
            .index = index,
            .tag = @tagName(tree.tokens.items(.tag)[token_index]),
            .spelling = tree.tokenSlice(index),
        };
    }
    const nodes = try allocator.alloc(InspectedNode, tree.nodes.len);
    var children: std.ArrayList(u32) = .empty;
    for (nodes, 0..) |*node, node_index| {
        const index: Ast.Node.Index = @fromBackingInt(@as(u32, @intCast(node_index)));
        children.clearRetainingCapacity();
        try inspectChildren(allocator, &children, tree, index);
        std.mem.sort(u32, children.items, tree, struct {
            fn before(ast: Ast, left: u32, right: u32) bool {
                return ast.firstToken(@fromBackingInt(left)) < ast.firstToken(@fromBackingInt(right));
            }
        }.before);
        node.* = .{
            .index = @intCast(node_index),
            .tag = @tagName(tree.nodes.items(.tag)[node_index]),
            .main_token = tree.nodes.items(.main_token)[node_index],
            .first_token = tree.firstToken(index),
            .last_token = tree.lastToken(index),
            .children = try allocator.dupe(u32, children.items),
        };
    }
    inspected_output = try std.json.Stringify.valueAlloc(allocator, .{
        .source = tree.source,
        .tokens = tokens,
        .nodes = nodes,
        .compiler_version = @import("builtin").zig_version_string,
    }, .{});
    rendered_output = formatted;
}

/// Read semantic children through the pinned compiler's full-node views. Token
/// and extra-data indices are not node indices, even when their storage matches.
fn inspectChildren(allocator: std.mem.Allocator, children: *std.ArrayList(u32), tree: Ast, index: Ast.Node.Index) !void {
    const tag = tree.nodeTag(index);
    const data = tree.nodeData(index);
    if (tag == .fn_decl) return appendChildValues(allocator, children, data.node_and_node);
    inline for (.{
        "fullVarDecl", "fullContainerField", "fullArrayType", "fullPtrType", "fullSlice",
        "fullIf",      "fullWhile",          "fullFor",       "fullSwitch",  "fullSwitchCase",
        "fullAsm",
    }) |name| {
        if (@field(Ast, name)(tree, index)) |full| return appendChildValues(allocator, children, full.ast);
    }
    inline for (.{
        .{ "fullFnProto", 1 },   .{ "fullCall", 1 },          .{ "fullStructInit", 2 },
        .{ "fullArrayInit", 2 }, .{ "fullContainerDecl", 2 },
    }) |entry| {
        var buffer: [entry[1]]Ast.Node.Index = undefined;
        if (@field(Ast, entry[0])(tree, &buffer, index)) |full| return appendChildValues(allocator, children, full.ast);
    }
    var buffer: [2]Ast.Node.Index = undefined;
    inline for (.{ "builtinCallParams", "blockStatements" }) |name| {
        if (@field(Ast, name)(tree, &buffer, index)) |items| return appendChildValues(allocator, children, items);
    }
    switch (tag) {
        .identifier,
        .number_literal,
        .string_literal,
        .char_literal,
        .enum_literal,
        .multiline_string_literal,
        .error_set_decl,
        .error_value,
        .unreachable_literal,
        .anyframe_literal,
        => {},
        .bool_not,
        .negation,
        .bit_not,
        .negation_wrap,
        .address_of,
        .@"try",
        .optional_type,
        .deref,
        .@"comptime",
        .@"nosuspend",
        .@"defer",
        .@"errdefer",
        .@"suspend",
        .@"resume",
        => try appendChildValues(allocator, children, data.node),
        .@"return" => try appendChildValues(allocator, children, data.opt_node),
        .@"break", .@"continue" => try appendChildValues(allocator, children, data.opt_token_and_opt_node[1]),
        .field_access, .unwrap_optional, .grouped_expression, .asm_input => try appendChildValues(allocator, children, data.node_and_token[0]),
        .test_decl => try appendChildValues(allocator, children, data.opt_token_and_node[1]),
        .anyframe_type => try appendChildValues(allocator, children, data.token_and_node[1]),
        .asm_output => try appendChildValues(allocator, children, data.opt_node_and_token[0]),
        .assign, .shl, .error_union => try appendChildValues(allocator, children, data.node_and_node),
        // This bridge emits the documented recipes, not arbitrary parsed Zig.
        // A new emitter shape must supply its real children before being shown.
        else => return error.UnsupportedAstNode,
    }
}

/// Only the compiler's typed node references are collected. FnProto.proto_node
/// identifies the current node, whereas its other node fields are children.
fn appendChildValues(allocator: std.mem.Allocator, children: *std.ArrayList(u32), value: anytype) !void {
    const Value = @TypeOf(value);
    if (Value == Ast.Node.Index) {
        try children.append(allocator, @backingInt(value));
    } else if (Value == Ast.Node.OptionalIndex) {
        if (value.unwrap()) |child| try children.append(allocator, @backingInt(child));
    } else if (Value == []const Ast.Node.Index) {
        for (value) |child| try children.append(allocator, @backingInt(child));
    } else if (@typeInfo(Value) == .@"struct") {
        inline for (@typeInfo(Value).@"struct".field_names) |name| {
            if (!comptime std.mem.eql(u8, name, "proto_node"))
                try appendChildValues(allocator, children, @field(value, name));
        }
    } else if (Value != Ast.TokenIndex and Value != ?Ast.TokenIndex and Value != bool) {
        @compileError("Unexpected AST component: " ++ @typeName(Value));
    }
}

fn emitEnum(allocator: std.mem.Allocator, context: *zast.AstContext, schema: Schema) !void {
    try validate(schema);
    const fields = try allocator.alloc(zast.Field, schema.fields.len);
    for (fields, schema.fields) |*field, description| {
        field.* = .{ .name = description.name };
        if (description.value) |integer| {
            const value = integer.value;
            const literal: zast.Expression = .{
                .integer_literal = try std.fmt.allocPrint(allocator, "{d}", .{@abs(value)}),
            };
            if (value < 0) {
                const operand = try allocator.create(zast.Expression);
                operand.* = literal;
                field.value = .{ .negate = operand };
            } else field.value = literal;
        }
    }
    const declaration = try zast.EnumDeclaration.init(
        allocator,
        schema.backing_type,
        schema.non_exhaustive,
        fields,
    );
    try declaration.emit(allocator, context, schema.name, .public);
}
