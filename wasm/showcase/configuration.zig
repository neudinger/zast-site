//! Compose nested types, defaults, and a method into an application config.
const std = @import("std");
const zast = @import("zast");

pub fn emit(allocator: std.mem.Allocator, context: *zast.AstContext, output_name: []const u8) !void {
    const byte: zast.Expression = .{ .identifier = "u8" };
    const text: zast.Expression = .{ .slice_type = .{ .child_type = &byte, .is_const = true } };
    const log_level: zast.EnumDeclaration = .{
        .backing_type = null,
        .non_exhaustive = false,
        .fields = &.{ .{ .name = "quiet" }, .{ .name = "info" }, .{ .name = "debug" } },
    };
    const self_type: zast.Expression = .{ .builtin_call = .{ .name = "@This" } };
    const self_value: zast.Expression = .{ .identifier = "self" };
    const method: zast.FunctionDeclaration = .{
        .parameters = &.{.{ .name = "self", .type_expression = .{ .pointer_type = .{ .child_type = &self_type, .is_const = true } } }},
        .return_type = text,
        .body = .{ .statements = &.{.{ .return_value = .{ .field_access = .{ .base = &self_value, .name = "host" } } }} },
    };
    const configuration: zast.StructDeclaration = .{ .members = &.{
        .{ .field = .{ .name = "host", .type_expression = text, .value = .{ .string_literal = "\"localhost\"" } } },
        .{ .field = .{ .name = "port", .type_expression = .{ .identifier = "u16" }, .value = .{ .integer_literal = "8080" } } },
        .{ .field = .{ .name = "log_level", .type_expression = zast.Expression.fromType(&log_level), .value = .{ .enum_literal = "info" } } },
        .{ .field = .{ .name = "token", .type_expression = .{ .optional_type = &text }, .value = .{ .identifier = "null" } } },
        .{ .function = .{ .name = "hostname", .declaration = &method, .visibility = .public } },
    } };
    try configuration.emit(allocator, context, output_name, .public);
}
