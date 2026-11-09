//! Adapt the pinned compiler's documentation viewer without changing its source
//! archive or Wasm. Paths are borrowed; returned buffers use the caller's arena.
const std = @import("std");
const files = @import("files.zig");

/// Fragments are embedded by the API layout. Only runtime files are installed.
pub const assets = [_]struct { name: []const u8, file: []const u8, install: ?[]const u8 = null }{
    .{ .name = "api-head", .file = "head.html" },
    .{ .name = "api-body", .file = "body.html" },
    .{ .name = "api-script", .file = "main.js", .install = "docs/api/main.js" },
    .{ .name = "api-wasm", .file = "main.wasm", .install = "docs/api/main.wasm" },
    .{ .name = "api-sources", .file = "sources.tar.gz", .install = "docs/api/sources.tar.gz" },
};

fn between(source: []const u8, opening: []const u8, closing: []const u8) ![]const u8 {
    if (std.mem.count(u8, source, opening) != 1 or std.mem.count(u8, source, closing) != 1) return error.UnsupportedViewerLayout;
    const start = std.mem.indexOf(u8, source, opening).? + opening.len;
    const end = std.mem.indexOfPos(u8, source, start, closing) orelse return error.UnsupportedViewerLayout;
    return source[start..end];
}

fn replaceOnce(allocator: std.mem.Allocator, source: []const u8, original: []const u8, replacement: []const u8) ![]const u8 {
    if (std.mem.count(u8, source, original) != 1) return error.UnsupportedViewerTransport;
    return files.replace(allocator, source, original, replacement);
}

/// Prepare cache-local build assets. Fail on upstream viewer changes before
/// writing any output; the website is published only after Zine and validation.
pub fn prepare(allocator: std.mem.Allocator, io: std.Io, input: []const u8, output: []const u8) !void {
    const html = try files.read(allocator, io, try std.fs.path.join(allocator, &.{ input, "index.html" }));
    var script: []const u8 = try files.read(allocator, io, try std.fs.path.join(allocator, &.{ input, "main.js" }));
    const wasm = try files.read(allocator, io, try std.fs.path.join(allocator, &.{ input, "main.wasm" }));
    const archive = try files.read(allocator, io, try std.fs.path.join(allocator, &.{ input, "sources.tar" }));
    if (wasm.len == 0 or archive.len == 0) return error.MissingApiAsset;
    const body = try between(html, "<body>", "</body>");
    const logo = try between(body, "<nav>", "</nav>");
    const viewer = std.mem.trim(u8, try files.replace(allocator, body, try std.fmt.allocPrint(allocator, "<nav>{s}</nav>", .{logo}), ""), " \n\r\t");
    var head: std.Io.Writer.Allocating = .init(allocator);
    var remaining = html;
    var count: usize = 0;
    while (std.mem.indexOf(u8, remaining, "<link rel=\"preload\"")) |start| {
        const end = (std.mem.indexOfScalarPos(u8, remaining, start, '>') orelse return error.UnsupportedViewerLayout) + 1;
        try head.writer.print("{s}\n", .{remaining[start..end]});
        remaining = remaining[end..];
        count += 1;
    }
    if (count != 2) return error.UnsupportedViewerLayout;
    const preload = try replaceOnce(allocator, try replaceOnce(allocator, head.written(), "href=\"sources.tar\"", "href=\"sources.tar.gz\""), "type=\"application/x-tar\"", "type=\"application/gzip\"");
    script = try replaceOnce(allocator, script, "fetch(\"sources.tar\")", "fetch(\"sources.tar.gz\")");
    script = try replaceOnce(allocator, script, "return response.arrayBuffer();", "return new Response(response.body.pipeThrough(new DecompressionStream(\"gzip\"))).arrayBuffer();");
    var compressed: std.Io.Writer.Allocating = .init(allocator);
    try compressed.ensureUnusedCapacity(16);
    var compressor = try std.compress.flate.Compress.init(&compressed.writer, try allocator.alloc(u8, std.compress.flate.max_window_len), .gzip, .best);
    try compressor.writer.writeAll(archive);
    try compressor.finish();
    const contents = [_][]const u8{ preload, viewer, script, wasm, compressed.written() };
    for (assets, contents) |asset, contents_bytes|
        try files.write(io, try std.fs.path.join(allocator, &.{ output, asset.file }), contents_bytes);
}
