//! Run Zine and validate its complete output before replacing the last valid site.
//! Paths are borrowed; command arguments and validation storage use a caller arena.
const std = @import("std");
const files = @import("files.zig");
const api = @import("api.zig");

pub const Options = struct {
    zine_executable: []const u8,
    wasm_file: []const u8,
    api_directory: []const u8,
    site_directory: []const u8 = ".",
    output_directory: []const u8 = "dist",
    engine_stderr: std.process.SpawnOptions.StdIo = .inherit,
};
pub const Result = struct { pages: usize = 0, references: usize = 0 };

pub const Attributes = struct {
    source: []const u8,
    needle: []const u8,
    offset: usize = 0,

    pub fn next(self: *Attributes) ?[]const u8 {
        while (std.mem.indexOfPos(u8, self.source, self.offset, self.needle)) |start| {
            self.offset = start + self.needle.len;
            if (start != 0 and (std.ascii.isAlphanumeric(self.source[start - 1]) or self.source[start - 1] == '_')) continue;
            const end = std.mem.indexOfScalarPos(u8, self.source, self.offset, '"') orelse return null;
            const value = self.source[self.offset..end];
            self.offset = end + 1;
            return value;
        }
        return null;
    }
};

pub fn attributes(source: []const u8, comptime name: []const u8) Attributes {
    return .{ .source = source, .needle = name ++ "=\"" };
}

/// Decode strict percent escapes before resolving paths; reject embedded separators
/// interpreted differently by URI and filesystem implementations.
pub fn decode(allocator: std.mem.Allocator, encoded: []const u8) ![]const u8 {
    var position: usize = 0;
    while (position < encoded.len) : (position += 1) if (encoded[position] == '%') {
        if (encoded.len - position < 3) return error.InvalidUrl;
        _ = std.fmt.parseInt(u8, encoded[position + 1 ..][0..2], 16) catch return error.InvalidUrl;
        position += 2;
    };
    const decoded = std.Uri.percentDecodeInPlace(try allocator.dupe(u8, encoded));
    if (std.mem.indexOfAny(u8, decoded, "\x00\\") != null or !std.unicode.utf8ValidateSlice(decoded)) return error.InvalidUrl;
    return decoded;
}

/// Return a normalized relative path, rejecting attempts to ascend above its root.
pub fn localPath(allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    var parts: std.ArrayList([]const u8) = .empty;
    var segments = std.mem.tokenizeScalar(u8, path, '/');
    while (segments.next()) |segment| {
        if (std.mem.eql(u8, segment, ".")) continue;
        if (std.mem.eql(u8, segment, "..")) {
            _ = parts.pop() orelse return error.PathEscapesRoot;
        } else try parts.append(allocator, segment);
    }
    return std.mem.join(allocator, "/", parts.items);
}

fn requireApiAsset(io: std.Io, path: []const u8) !void {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch return error.MissingApiAsset;
    if (stat.kind != .file or stat.size == 0) return error.MissingApiAsset;
}

pub fn validate(allocator: std.mem.Allocator, io: std.Io, directory: []const u8) !Result {
    try requireApiAsset(io, try std.fs.path.join(allocator, &.{ directory, "docs/api/index.html" }));
    for (api.assets) |asset| if (asset.install) |destination| {
        try requireApiAsset(io, try std.fs.path.join(allocator, &.{ directory, destination }));
    };
    const Page = struct { html: []const u8, identifiers: std.StringHashMapUnmanaged(void) = .empty };
    var pages: std.StringArrayHashMapUnmanaged(Page) = .empty;
    for (try files.list(allocator, io, directory)) |relative| {
        if (!std.mem.endsWith(u8, relative, ".html")) continue;
        var page: Page = .{ .html = try files.read(allocator, io, try std.fs.path.join(allocator, &.{ directory, relative })) };
        var identifiers = attributes(page.html, "id");
        while (identifiers.next()) |identifier| {
            const entry = try page.identifiers.getOrPut(allocator, identifier);
            if (entry.found_existing) return error.DuplicateHtmlId;
        }
        if (!std.mem.eql(u8, relative, "docs/api/index.html")) {
            var offset: usize = 0;
            var headings: usize = 0;
            while (std.mem.indexOfPos(u8, page.html, offset, "<h1")) |start| {
                offset = start + 3;
                if (offset < page.html.len and (page.html[offset] == '>' or std.ascii.isWhitespace(page.html[offset]))) headings += 1;
            }
            if (headings != 1) return error.InvalidHeadingCount;
        }
        try pages.put(allocator, relative, page);
    }
    var result: Result = .{ .pages = pages.count() };
    for (pages.keys(), pages.values()) |relative, page| {
        const base = try std.Uri.parse(try std.fmt.allocPrint(allocator, "https://site.invalid/{s}", .{relative}));
        inline for (.{ "href", "src" }) |attribute| {
            var references = attributes(page.html, attribute);
            while (references.next()) |reference| {
                const unescaped = try files.replace(allocator, reference, "&amp;", "&");
                var buffer = try allocator.alloc(u8, unescaped.len * 2 + relative.len + 256);
                @memcpy(buffer[0..unescaped.len], unescaped);
                const uri = try std.Uri.resolveInPlace(base, unescaped.len, &buffer);
                if (!std.ascii.eqlIgnoreCase(uri.scheme, "https") or uri.host == null or !std.ascii.eqlIgnoreCase(try uri.host.?.toRawMaybeAlloc(allocator), "site.invalid") or (uri.port != null and uri.port.? != 443)) continue;
                var target = try localPath(allocator, try decode(allocator, uri.path.percent_encoded));
                var target_path = try std.fs.path.join(allocator, &.{ directory, target });
                const stat = std.Io.Dir.cwd().statFile(io, target_path, .{}) catch return error.MissingLocalReference;
                if (stat.kind == .directory) {
                    target = try std.fs.path.join(allocator, &.{ target, "index.html" });
                    target_path = try std.fs.path.join(allocator, &.{ directory, target });
                }
                if (!try files.exists(io, target_path)) return error.MissingLocalReference;
                if (uri.fragment) |fragment| if (!fragment.isEmpty() and !std.mem.eql(u8, target, "docs/api/index.html")) {
                    const destination = pages.get(target) orelse return error.MissingFragment;
                    if (!destination.identifiers.contains(try decode(allocator, fragment.percent_encoded))) return error.MissingFragment;
                };
                result.references += 1;
            }
        }
    }
    return result;
}

/// Reject overlapping authored and generated destinations before Zine writes.
/// Zine also performs its own page and asset analysis; it does not include build
/// assets in every collision check, so those reservations remain explicit here.
pub fn preflight(allocator: std.mem.Allocator, io: std.Io, directory: []const u8) !void {
    var destinations: std.StringHashMapUnmanaged(void) = .empty;
    for (api.assets) |asset| if (asset.install) |install| try destinations.put(allocator, install, {});
    try destinations.put(allocator, "playground.wasm", {});
    const asset_directory = try std.fs.path.join(allocator, &.{ directory, "assets" });
    for (try files.list(allocator, io, asset_directory)) |relative| {
        if ((try destinations.getOrPut(allocator, relative)).found_existing) return error.GeneratedAssetCollision;
    }
    var pages: std.StringHashMapUnmanaged(void) = .empty;
    for (try files.list(allocator, io, try std.fs.path.join(allocator, &.{ directory, "content" }))) |relative| {
        if (!std.mem.endsWith(u8, relative, ".smd")) {
            if ((try destinations.getOrPut(allocator, relative)).found_existing) return error.AssetCollision;
            continue;
        }
        var stem = relative[0 .. relative.len - 4];
        if (std.mem.eql(u8, stem, "index")) stem = "" else if (std.mem.endsWith(u8, stem, "/index")) stem = stem[0 .. stem.len - 6];
        const destination = try std.fs.path.join(allocator, &.{ stem, "index.html" });
        if ((try pages.getOrPut(allocator, destination)).found_existing) return error.DuplicatePageRoute;
        if ((try destinations.getOrPut(allocator, destination)).found_existing) return error.PageAssetCollision;
    }
    _ = try files.list(allocator, io, try std.fs.path.join(allocator, &.{ directory, "layouts" }));
}

fn addAsset(allocator: std.mem.Allocator, command: *std.ArrayList([]const u8), base: []const u8, name: []const u8, path: []const u8, install: ?[]const u8) !void {
    // The pinned live server expects build-asset input paths relative to its
    // project directory, including when their files live in an external cache.
    const absolute = try std.fs.path.resolve(allocator, &.{path});
    try command.appendSlice(allocator, &.{ try std.fmt.allocPrint(allocator, "--build-asset={s}", .{name}), try std.fs.path.relativeAlloc(allocator, base, null, base, absolute) });
    if (install) |destination| try command.append(allocator, try std.fmt.allocPrint(allocator, "--install-always={s}", .{destination}));
}

/// Release and live preview share identical asset bindings. A null output selects
/// Zine's loopback development server; otherwise use a fresh staging directory.
pub fn arguments(allocator: std.mem.Allocator, io: std.Io, options: Options, output: ?[]const u8) ![]const []const u8 {
    const base = try std.Io.Dir.cwd().realPathFileAlloc(io, options.site_directory, allocator);
    var command: std.ArrayList([]const u8) = .empty;
    try command.append(allocator, try std.fs.path.resolve(allocator, &.{options.zine_executable}));
    if (output) |directory| {
        try command.appendSlice(allocator, &.{ "release", try std.fmt.allocPrint(allocator, "--output={s}", .{directory}) });
    } else try command.appendSlice(allocator, &.{ "--host=127.0.0.1", "--port=1990" });
    try addAsset(allocator, &command, base, "playground", options.wasm_file, "playground.wasm");
    for (api.assets) |asset| try addAsset(allocator, &command, base, asset.name, try std.fs.path.join(allocator, &.{ options.api_directory, asset.file }), asset.install);
    return command.toOwnedSlice(allocator);
}

/// Own the release subprocess and staging directory. A failed engine or final
/// validation leaves the previous output untouched; failed renames restore it.
pub fn build(allocator: std.mem.Allocator, io: std.Io, options: Options) !Result {
    try preflight(allocator, io, options.site_directory);
    const destination = try std.fs.path.resolveAlloc(allocator, &.{ try std.process.currentPathAlloc(io, allocator), options.output_directory });
    const staging = try files.staging(allocator, io, destination);
    defer std.Io.Dir.cwd().deleteTree(io, staging) catch {};
    var child = try std.process.spawn(io, .{ .argv = try arguments(allocator, io, options, staging), .cwd = .{ .path = options.site_directory }, .stderr = options.engine_stderr });
    defer child.kill(io);
    if (!(try child.wait(io)).success()) return error.ZineFailed;
    const result = try validate(allocator, io, staging);
    const backup = try std.fmt.allocPrint(allocator, "{s}.previous", .{staging});
    const had_previous = try files.exists(io, destination);
    if (had_previous) try std.Io.Dir.cwd().rename(destination, .cwd(), backup, io);
    std.Io.Dir.cwd().rename(staging, .cwd(), destination, io) catch |failure| {
        if (had_previous) try std.Io.Dir.cwd().rename(backup, .cwd(), destination, io);
        return failure;
    };
    if (had_previous) try std.Io.Dir.cwd().deleteTree(io, backup);
    return result;
}

/// Replace the coordinator with Zine so Ctrl+C reaches the live server directly.
/// Source, layout, and asset changes reload; native artifacts require a rebuild.
pub fn serve(allocator: std.mem.Allocator, io: std.Io, options: Options) !void {
    try preflight(allocator, io, options.site_directory);
    return std.process.replace(io, .{ .argv = try arguments(allocator, io, options, null), .cwd = .{ .path = options.site_directory } });
}
