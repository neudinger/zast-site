//! JSON integer tokens with no coercion from strings or floating-point numbers.
//! The bridge preserves numeric spellings with `.parse_numbers = false`.
const std = @import("std");

pub const JsonInteger = struct {
    value: i64,

    pub fn jsonParseFromValue(_: std.mem.Allocator, source: std.json.Value, _: std.json.ParseOptions) std.json.ParseFromValueError!@This() {
        return .{ .value = try std.fmt.parseInt(i64, switch (source) {
            .number_string => |spelling| spelling,
            else => return error.UnexpectedToken,
        }, 10) };
    }
};
