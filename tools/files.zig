//! Small filesystem operations shared by the site tools. Paths are caller-owned.
const std = @import("std");

pub fn read(allocator: std.mem.Allocator, io: std.Io, path: []const u8) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(64 * 1024 * 1024));
}

pub fn write(io: std.Io, path: []const u8, contents: []const u8) !void {
    if (std.fs.path.dirname(path)) |parent| try std.Io.Dir.cwd().createDirPath(io, parent);
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = contents });
}

pub fn exists(io: std.Io, path: []const u8) !bool {
    _ = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch |failure| switch (failure) {
        error.FileNotFound => return false,
        else => return failure,
    };
    return true;
}

/// Return sorted relative file names; reject symlinks and special files.
/// The caller releases both the strings and their slice, or uses an arena.
pub fn list(allocator: std.mem.Allocator, io: std.Io, path: []const u8) ![][]const u8 {
    const directory = try std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true, .follow_symlinks = false });
    defer directory.close(io);
    var walker = try directory.walk(allocator);
    defer walker.deinit();
    var names: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (names.items) |name| allocator.free(name);
        names.deinit(allocator);
    }
    while (try walker.next(io)) |entry| switch (entry.kind) {
        .directory => {},
        .file => {
            const name = try allocator.dupe(u8, entry.path);
            errdefer allocator.free(name);
            try names.append(allocator, name);
        },
        else => return error.UnsupportedFileKind,
    };
    std.mem.sort([]const u8, names.items, {}, struct {
        fn lessThan(_: void, left: []const u8, right: []const u8) bool {
            return std.mem.lessThan(u8, left, right);
        }
    }.lessThan);
    return names.toOwnedSlice(allocator);
}

pub fn copyTree(allocator: std.mem.Allocator, io: std.Io, source: []const u8, destination: []const u8) !void {
    try std.Io.Dir.cwd().createDirPath(io, destination);
    const names = try list(allocator, io, source);
    defer {
        for (names) |name| allocator.free(name);
        allocator.free(names);
    }
    for (names) |name| {
        const origin = try std.fs.path.join(allocator, &.{ source, name });
        defer allocator.free(origin);
        const target = try std.fs.path.join(allocator, &.{ destination, name });
        defer allocator.free(target);
        try std.Io.Dir.cwd().copyFile(origin, .cwd(), target, io, .{ .make_path = true });
    }
}

/// Create a unique sibling of the output so the final rename stays on one filesystem.
pub fn staging(allocator: std.mem.Allocator, io: std.Io, output: []const u8) ![]const u8 {
    var random: [16]u8 = undefined;
    io.random(&random);
    const path = try std.fmt.allocPrint(allocator, "{s}/.zine-build-{x}", .{ std.fs.path.dirname(output) orelse ".", &random });
    errdefer allocator.free(path);
    try std.Io.Dir.cwd().createDir(io, path, .default_dir);
    return path;
}

pub fn replace(allocator: std.mem.Allocator, source: []const u8, original: []const u8, replacement: []const u8) ![]u8 {
    return std.mem.replaceOwned(u8, allocator, source, original, replacement);
}
