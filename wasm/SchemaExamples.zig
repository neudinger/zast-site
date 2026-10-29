//! Small schema lessons, deliberately limited to UByte enums and UInt fields.
//! Metadata is ignored; input is bounded by the bridge's 4 KiB limit.
const std = @import("std");
const zast = @import("zast");
const JsonInteger = @import("JsonInteger.zig").JsonInteger;
const Schema = struct {
    enums: []const struct {
        name: []const u8,
        underlying_type: struct { base_type: []const u8 },
        values: []const struct { name: []const u8, value: JsonInteger },
        is_union: bool = false,
    } = &.{},
    objects: []const struct {
        name: []const u8,
        fields: []const struct {
            name: []const u8,
            type: struct { base_type: []const u8 },
            default_integer: JsonInteger = .{ .value = 0 },
        },
        is_struct: bool = false,
    } = &.{},
};

fn identifier(allocator: std.mem.Allocator, name: []const u8) ![]const u8 {
    if (name.len == 0 or name.len > 64) return error.InvalidIdentifier;
    return std.fmt.allocPrint(allocator, "{f}", .{std.zig.fmtId(name)});
}

pub fn emit(allocator: std.mem.Allocator, context: *zast.AstContext, value: std.json.Value, with_method: bool) !void {
    const parsed = try std.json.parseFromValue(Schema, allocator, value, .{ .ignore_unknown_fields = true });
    const schema = parsed.value;
    if (schema.enums.len + schema.objects.len > 16) return error.TooManyDeclarations;
    for (schema.enums) |enumeration| {
        if (enumeration.is_union or !std.mem.eql(u8, enumeration.underlying_type.base_type, "UByte")) return error.UnsupportedSchema;
        if (enumeration.values.len > 32) return error.TooManyFields;
        const fields = try allocator.alloc(zast.Field, enumeration.values.len);
        for (enumeration.values, fields, 0..) |entry, *field, entry_index| {
            const number = std.math.cast(u8, entry.value.value) orelse return error.ValueOutOfRange;
            for (enumeration.values[0..entry_index]) |previous| {
                if (std.mem.eql(u8, previous.name, entry.name)) return error.DuplicateField;
                if (previous.value.value == entry.value.value) return error.DuplicateValue;
            }
            field.* = .{ .name = try identifier(allocator, entry.name), .value = .{
                .integer_literal = try std.fmt.allocPrint(allocator, "{d}", .{number}),
            } };
        }
        const declaration: zast.EnumDeclaration = .{ .backing_type = "u8", .non_exhaustive = true, .fields = fields };
        try declaration.emit(allocator, context, try identifier(allocator, enumeration.name), .public);
    }
    for (schema.objects) |object| {
        if (object.is_struct) return error.UnsupportedSchema;
        if (object.fields.len > 32) return error.TooManyFields;
        const members = try allocator.alloc(zast.StructDeclaration.Member, object.fields.len + @as(usize, @intFromBool(with_method)));
        for (object.fields, members[0..object.fields.len], 0..) |field, *member, field_index| {
            if (!std.mem.eql(u8, field.type.base_type, "UInt")) return error.UnsupportedSchema;
            const number = std.math.cast(u32, field.default_integer.value) orelse return error.ValueOutOfRange;
            if (with_method and std.mem.eql(u8, field.name, "answerFunc")) return error.DuplicateField;
            for (object.fields[0..field_index]) |previous| {
                if (std.mem.eql(u8, previous.name, field.name)) return error.DuplicateField;
            }
            member.* = .{ .field = .{
                .name = try identifier(allocator, field.name),
                .type_expression = .{ .identifier = "u32" },
                .value = .{ .integer_literal = try std.fmt.allocPrint(allocator, "{d}", .{number}) },
            } };
        }
        const method: zast.FunctionDeclaration = .{
            .return_type = .{ .identifier = "u32" },
            .body = .{ .statements = &.{.{ .return_value = .{ .integer_literal = "84" } }} },
        };
        if (with_method) members[object.fields.len] = .{ .function = .{
            .name = "answerFunc",
            .declaration = &method,
            .visibility = .public,
        } };
        const declaration: zast.StructDeclaration = .{ .members = members };
        try declaration.emit(allocator, context, try identifier(allocator, object.name), .public);
    }
}
