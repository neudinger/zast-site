//! Bounded JSON descriptions mapped into the existing zast components.
//! Strings borrow the parsed JSON; recursive descriptors use the caller's arena.
//! This layer supplies input validation, not a second source or AST generator.
const std = @import("std");
const zast = @import("zast");

/// A complete file description. `example` identifies a catalogue entry only;
/// declarations and comments fully determine the generated source.
pub const File = struct {
    example: ?[]const u8 = null,
    declarations: []const Named,
    comment: ?[]const u8 = null,
    container_doc_comment: ?[]const u8 = null,
};

/// Exactly one binding or named function, with an optional plain-text doc comment.
pub const Named = struct {
    name: []const u8,
    visibility: zast.Declaration.Visibility = .public,
    declaration: ?zast.Declaration = null,
    function: ?zast.FunctionDeclaration = null,
    doc_comment: ?[]const u8 = null,
};

/// Decode into caller-arena descriptions. Unknown properties, malformed token
/// spellings, ambiguous roots, and excessive recursion or list sizes are errors.
/// Synthetic expression tags enum_type/union_type/struct_type/function_type wrap
/// the corresponding descriptor using Expression.fromType; raw callbacks are rejected.
pub fn parse(allocator: std.mem.Allocator, value: std.json.Value) !File {
    var decoder: Decoder = .{ .allocator = allocator };
    const file = try decoder.decode(File, value, 0);
    for (file.declarations) |named| {
        if ((named.declaration == null) == (named.function == null))
            return error.InvalidDeclaration;
    }
    return file;
}

/// Append the file to an initialized context whose root has already been reserved.
/// All allocations belong to the supplied arena, including failure paths.
pub fn emit(allocator: std.mem.Allocator, context: *zast.AstContext, value: std.json.Value) !void {
    const file = try parse(allocator, value);
    if (file.comment) |text| try comment(allocator, context, text, null);
    if (file.container_doc_comment) |text|
        try comment(allocator, context, text, .container_doc_comment);
    for (file.declarations) |named| {
        if (named.doc_comment) |text| try comment(allocator, context, text, .doc_comment);
        if (named.declaration) |declaration|
            try declaration.emit(allocator, context, named.name, named.visibility)
        else
            try named.function.?.emit(allocator, context, named.name, named.visibility);
    }
}

fn comment(
    allocator: std.mem.Allocator,
    context: *zast.AstContext,
    text: []const u8,
    tag: ?std.zig.Token.Tag,
) !void {
    if (std.mem.indexOfScalar(u8, text, 0) != null or
        std.mem.indexOfScalar(u8, text, '\r') != null) return error.InvalidComment;
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        const prefix = if (tag == .doc_comment) "///" else if (tag != null) "//!" else "//";
        const spelling = try std.fmt.allocPrint(allocator, "{s} {s}", .{ prefix, line });
        if (tag) |token_tag|
            _ = try context.token(allocator, token_tag, spelling)
        else
            try context.source.appendSlice(allocator, spelling);
        try context.source.append(allocator, '\n');
    }
}

const Decoder = struct {
    allocator: std.mem.Allocator,
    remaining: usize = 4096,

    fn decode(self: *Decoder, comptime Result: type, value: std.json.Value, depth: usize) anyerror!Result {
        if (depth > 64) return error.DescriptionTooDeep;
        if (self.remaining == 0) return error.DescriptionTooLarge;
        self.remaining -= 1;
        if (Result == zast.Expression) {
            if (value != .object or value.object.count() != 1) return error.UnexpectedToken;
            inline for (.{
                .{ "enum_type", zast.EnumDeclaration },
                .{ "union_type", zast.UnionDeclaration },
                .{ "struct_type", zast.StructDeclaration },
                .{ "function_type", zast.FunctionDeclaration },
            }) |entry| {
                if (value.object.get(entry[0])) |description| {
                    const descriptor = try self.allocator.create(entry[1]);
                    descriptor.* = try self.decode(entry[1], description, depth + 1);
                    return zast.Expression.fromType(descriptor);
                }
            }
        }
        return switch (@typeInfo(Result)) {
            .bool => if (value == .bool) value.bool else error.UnexpectedToken,
            .void => if (value == .null or
                (value == .object and value.object.count() == 0))
            {} else error.UnexpectedToken,
            .optional => |optional| if (value == .null) null else try self.decode(optional.child, value, depth + 1),
            .pointer => |pointer| switch (pointer.size) {
                .one => pointer_blk: {
                    const result = try self.allocator.create(pointer.child);
                    result.* = try self.decode(pointer.child, value, depth + 1);
                    break :pointer_blk result;
                },
                .slice => if (pointer.child == u8) string_blk: {
                    if (value != .string) return error.UnexpectedToken;
                    break :string_blk value.string;
                } else slice_blk: {
                    if (value != .array) return error.UnexpectedToken;
                    if (value.array.items.len > 128) return error.TooManyItems;
                    const result = try self.allocator.alloc(pointer.child, value.array.items.len);
                    for (result, value.array.items) |*destination, item|
                        destination.* = try self.decode(pointer.child, item, depth + 1);
                    break :slice_blk result;
                },
                else => error.UnsupportedDescription,
            },
            .@"enum" => if (value == .string)
                std.meta.stringToEnum(Result, value.string) orelse error.UnknownField
            else
                error.UnexpectedToken,
            .@"union" => |union_info| union_blk: {
                const name, const payload = if (value == .string)
                    .{ value.string, std.json.Value.null }
                else if (value == .object and value.object.count() == 1)
                    .{ value.object.keys()[0], value.object.values()[0] }
                else
                    return error.UnexpectedToken;
                inline for (union_info.field_names, union_info.field_types) |field_name, Field| {
                    if (comptime Result == zast.Expression and
                        std.mem.eql(u8, field_name, "type_description")) continue;
                    if (std.mem.eql(u8, name, field_name)) {
                        if (value == .string and Field != void) return error.UnexpectedToken;
                        const decoded = try self.decode(Field, payload, depth + 1);
                        if (Result == zast.Expression) try self.validateExpression(field_name, decoded);
                        break :union_blk @unionInit(Result, field_name, decoded);
                    }
                }
                break :union_blk error.UnknownField;
            },
            .@"struct" => |structure| struct_blk: {
                if (value != .object) return error.UnexpectedToken;
                var result: Result = undefined;
                var recognized: usize = 0;
                inline for (structure.field_names, structure.field_types, structure.field_attrs) |
                    field_name,
                    Field,
                    attributes,
                | {
                    if (value.object.get(field_name)) |field_value| {
                        @field(result, field_name) = try self.decode(Field, field_value, depth + 1);
                        recognized += 1;
                    } else if (comptime attributes.defaultValue(Field)) |default| {
                        @field(result, field_name) = default;
                    } else return error.MissingField;
                    if (comptime std.mem.eql(u8, field_name, "name") or
                        (Result == zast.EnumDeclaration and std.mem.eql(u8, field_name, "backing_type")))
                    {
                        const spelling: ?[]const u8 = @field(result, field_name);
                        if (spelling) |text| try self.token(text, if (Result ==
                            @FieldType(zast.Expression, "builtin_call")) .builtin else .identifier);
                    }
                }
                if (recognized != value.object.count()) return error.UnknownField;
                break :struct_blk result;
            },
            else => error.UnsupportedDescription,
        };
    }

    fn validateExpression(self: *Decoder, comptime tag: []const u8, payload: anytype) !void {
        if (comptime std.mem.eql(u8, tag, "integer_literal")) {
            try self.token(payload, .number_literal);
            switch (std.zig.parseNumberLiteral(payload)) {
                .int, .big_int => {},
                else => return error.InvalidLiteral,
            }
        } else if (comptime std.mem.eql(u8, tag, "string_literal")) {
            try self.token(payload, .string_literal);
            _ = try std.zig.string_literal.parseAlloc(self.allocator, payload);
        } else if (comptime std.mem.eql(u8, tag, "char_literal")) {
            try self.token(payload, .char_literal);
            if (std.zig.string_literal.parseCharLiteral(payload) == .failure)
                return error.InvalidLiteral;
        } else if (comptime std.mem.eql(u8, tag, "identifier") or
            std.mem.eql(u8, tag, "enum_literal"))
        {
            try self.token(payload, .identifier);
        } else if (comptime std.mem.eql(u8, tag, "error_set_type")) {
            for (payload) |name| try self.token(name, .identifier);
        }
    }

    fn token(self: *Decoder, spelling: []const u8, expected: std.zig.Token.Tag) !void {
        const source = try self.allocator.dupeSentinel(u8, spelling, 0);
        var tokenizer = std.zig.Tokenizer.init(source);
        const parsed = tokenizer.next();
        if (parsed.tag != expected or parsed.loc.start != 0 or parsed.loc.end != spelling.len or
            tokenizer.next().tag != .eof) return error.InvalidToken;
        if (expected == .identifier and std.mem.startsWith(u8, spelling, "@\""))
            _ = try std.zig.string_literal.parseAlloc(self.allocator, spelling[1..]);
    }
};

test "complete descriptions use fields, expressions, and function statements" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const value = try std.json.parseFromSliceLeaky(std.json.Value, allocator,
        \\{"declarations":[{"name":"answer","declaration":{"type_expression":{"identifier":"u32"},"value":{"integer_literal":"73"}}},{"name":"identity","function":{"parameters":[{"name":"input","type_expression":{"identifier":"u32"}}],"return_type":{"identifier":"u32"},"body":{"statements":[{"return_value":{"identifier":"input"}}]}}}]}
    , .{});
    var context: zast.AstContext = .{};
    _ = try context.addNode(allocator, .root, 0, undefined);
    try emit(allocator, &context, value);
    const tree = try context.finish(allocator);
    try std.testing.expectEqualStrings(
        "pub const answer: u32 = 73;\npub fn identity(input: u32) u32 {\n    return input;\n}\n",
        try tree.renderAlloc(allocator),
    );
}

test "catalogue descriptions emit complete parseable Zig" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const descriptions = try std.json.parseFromSliceLeaky(
        std.json.Value,
        allocator,
        @embedFile("descriptions.json"),
        .{},
    );
    for (descriptions.object.values()) |description| {
        var context: zast.AstContext = .{};
        _ = try context.addNode(allocator, .root, 0, undefined);
        try emit(allocator, &context, description);
        const tree = try context.finish(allocator);
        const source = try tree.renderAlloc(allocator);
        const terminated = try allocator.dupeSentinel(u8, source, 0);
        const parsed = try std.zig.Ast.parse(allocator, terminated, .{});
        try std.testing.expectEqual(@as(usize, 0), parsed.errors.len);
    }
}

test "unit union tags accept object forms and payload tags require their value" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    for ([_][]const u8{
        \\{"declarations":[{"name":"Pointer","declaration":{"value":{"pointer_type":{"child_type":{"identifier":"u8"},"kind":{"single":{}}}}}}]}
        ,
        \\{"declarations":[{"name":"Payload","declaration":{"value":{"union_type":{"tag_type":{"inferred":null},"fields":[{"name":"none"}]}}}}]}
        ,
    }) |source| {
        const value = try std.json.parseFromSliceLeaky(std.json.Value, allocator, source, .{});
        _ = try parse(allocator, value);
    }
    for ([_][]const u8{
        \\{"declarations":[{"name":"Pointer","declaration":{"value":{"pointer_type":{"child_type":{"identifier":"u8"},"kind":"many"}}}}]}
        ,
        \\{"declarations":[{"name":"noop","function":{"body":{"statements":["return_value"]}}}]}
        ,
    }) |source| {
        const value = try std.json.parseFromSliceLeaky(std.json.Value, allocator, source, .{});
        try std.testing.expectError(error.UnexpectedToken, parse(allocator, value));
    }
}
