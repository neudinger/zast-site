//! Small filesystem operations shared by the site tools. Paths are caller-owned.
const std = @import("std");

pub fn read(allocator: std.mem.Allocator, io: std.Io, path: []const u8) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(64 * 1024 * 1024));
}

pub fn write(io: std.Io, path: []const u8, contents: []const u8) !void {
    if (std.fs.path.dirname(path)) |parent| try std.Io.Dir.cwd().createDirPath(io, parent);
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = contents });
}

pub fn replace(allocator: std.mem.Allocator, source: []const u8, original: []const u8, replacement: []const u8) ![]u8 {
    return std.mem.replaceOwned(u8, allocator, source, original, replacement);
}
