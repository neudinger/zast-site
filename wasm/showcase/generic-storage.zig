//! Emit a generic type factory returning a struct with a method.
const std = @import("std");
const zast = @import("zast");

pub fn emit(allocator: std.mem.Allocator, context: *zast.AstContext, output_name: []const u8) !void {
    const item: zast.Expression = .{ .identifier = "Item" };
    const items: zast.Expression = .{ .slice_type = .{ .child_type = &item, .is_const = true } };
    const self_type: zast.Expression = .{ .builtin_call = .{ .name = "@This" } };
    const self_value: zast.Expression = .{ .identifier = "self" };
    const view: zast.FunctionDeclaration = .{
        .parameters = &.{.{ .name = "self", .type_expression = .{ .pointer_type = .{ .child_type = &self_type, .is_const = true } } }},
        .return_type = items,
        .body = .{ .statements = &.{.{ .return_value = .{ .field_access = .{ .base = &self_value, .name = "items" } } }} },
    };
    const storage: zast.StructDeclaration = .{ .members = &.{
        .{ .field = .{ .name = "items", .type_expression = items } },
        .{ .function = .{ .name = "view", .declaration = &view, .visibility = .public } },
    } };
    const factory: zast.FunctionDeclaration = .{
        .parameters = &.{.{ .name = "Item", .is_comptime = true, .type_expression = .{ .identifier = "type" } }},
        .return_type = .{ .identifier = "type" },
        .body = .{ .statements = &.{.{ .return_value = zast.Expression.fromType(&storage) }} },
    };
    try factory.emit(allocator, context, output_name, .public);
}
