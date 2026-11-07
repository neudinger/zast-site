const std = @import("std");
const generated = @import("generated-output.zig");

test "generated declarations parse and retain their exact formatted source" {
    const allocator = std.testing.allocator;
    const source = @embedFile("generated-output.zig");
    var tree = try std.zig.Ast.parse(allocator, source, .{});
    defer tree.deinit(allocator);
    try std.testing.expectEqual(@as(usize, 0), tree.errors.len);
    const rendered = try tree.renderAlloc(allocator);
    defer allocator.free(rendered);
    try std.testing.expectEqualStrings(source, rendered);
}

test "generated enum types and values pass Zig semantic analysis" {
    try std.testing.expectEqual(@as(usize, 1), @backingInt(generated.Status.ok));
    try std.testing.expectEqual(@as(u8, 1), @backingInt(generated.Numeric.ok));
    try std.testing.expectEqual(@as(i16, -4), @backingInt(generated.Signed.negative));
    try std.testing.expectEqual(@as(usize, 0), @typeInfo(generated.Empty).@"enum".field_names.len);
    const unnamed: generated.Offset = @fromBackingInt(@intCast(@as(u32, 42)));
    try std.testing.expectEqual(@as(u32, 42), @backingInt(unnamed));
    try std.testing.expectEqual(@as(u16, 11), @backingInt(generated.Implicit.next));
    try std.testing.expectEqual(@as(u16, 1), @backingInt(generated.Implicit.last));
    try std.testing.expectEqual(std.math.minInt(i32), @backingInt(generated.Edges.minimum));
    try std.testing.expectEqual(std.math.maxInt(i32), @backingInt(generated.Edges.maximum));
    try std.testing.expectEqual(std.math.maxInt(u32), @backingInt(generated.Unsigned.maximum));
    try std.testing.expectEqual(std.math.minInt(i8), @backingInt(generated.SmallSigned.minimum));
    try std.testing.expectEqual(std.math.maxInt(i8), @backingInt(generated.SmallSigned.maximum));
}
