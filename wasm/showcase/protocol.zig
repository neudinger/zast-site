//! Compose a packed header, a named-tag union, and a packet type.
const std = @import("std");
const zast = @import("zast");

pub fn emit(allocator: std.mem.Allocator, context: *zast.AstContext, output_name: []const u8) !void {
    const operation: zast.EnumDeclaration = .{
        .backing_type = "u8",
        .non_exhaustive = false,
        .fields = &.{ .{ .name = "ping" }, .{ .name = "data" } },
    };
    try operation.emit(allocator, context, "Operation", .public);
    const flags: zast.StructDeclaration = .{
        .layout = .@"packed",
        .members = &.{
            .{ .field = .{ .name = "urgent", .type_expression = .{ .identifier = "bool" }, .value = .{ .identifier = "false" } } },
            .{ .field = .{ .name = "encrypted", .type_expression = .{ .identifier = "bool" }, .value = .{ .identifier = "false" } } },
            .{ .field = .{ .name = "reserved", .type_expression = .{ .identifier = "u6" }, .value = .{ .integer_literal = "0" } } },
        },
    };
    try flags.emit(allocator, context, "Flags", .public);
    const byte: zast.Expression = .{ .identifier = "u8" };
    const payload: zast.UnionDeclaration = .{
        .tag_type = .{ .enum_type = .{ .identifier = "Operation" } },
        .fields = &.{
            .{ .name = "ping", .type_expression = .{ .identifier = "void" } },
            .{ .name = "data", .type_expression = .{ .slice_type = .{ .child_type = &byte, .is_const = true } } },
        },
    };
    try payload.emit(allocator, context, "Payload", .public);
    const packet: zast.StructDeclaration = .{ .members = &.{
        .{ .field = .{ .name = "sequence", .type_expression = .{ .identifier = "u32" } } },
        .{ .field = .{ .name = "flags", .type_expression = .{ .identifier = "Flags" }, .value = .{ .struct_init = .{} } } },
        .{ .field = .{ .name = "payload", .type_expression = .{ .identifier = "Payload" } } },
    } };
    try packet.emit(allocator, context, output_name, .public);
}
