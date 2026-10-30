const std = @import("std");
const site = @import("site");
const paths = @import("paths");

comptime {
    _ = @import("build_tools.zig");
}

const Fixture = struct {
    temporary: std.testing.TmpDir,
    arena: std.heap.ArenaAllocator,
    options: site.website.Options,
    content_directory: []const u8,
    api_input_directory: []const u8,

    fn init() !Fixture {
        var temporary = std.testing.tmpDir(.{ .iterate = true });
        errdefer temporary.cleanup();
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        errdefer arena.deinit();
        const allocator = arena.allocator();
        const root = try temporary.dir.realPathFileAlloc(std.testing.io, ".", allocator);
        for ([_][]const u8{ "content", "assets", "layouts" }) |directory|
            try site.files.copyTree(allocator, std.testing.io, directory, try std.fs.path.join(allocator, &.{ root, directory }));
        try site.files.write(std.testing.io, try std.fs.path.join(allocator, &.{ root, "zine.ziggy" }), try site.files.read(allocator, std.testing.io, "zine.ziggy"));
        const api_input = try std.fs.path.join(allocator, &.{ root, "compiler-docs" });
        try site.files.copyTree(allocator, std.testing.io, paths.api_directory, api_input);
        // Negative cases need only a small archive. The integrity test below
        // compares the complete compiler archive independently.
        try site.files.write(std.testing.io, try std.fs.path.join(allocator, &.{ api_input, "sources.tar" }), "Fixture source archive\n");
        return .{
            .temporary = temporary,
            .arena = arena,
            .content_directory = try std.fs.path.join(allocator, &.{ root, "content" }),
            .api_input_directory = api_input,
            .options = .{
                // The engine runs from the temporary site, not the build root.
                .zine_executable = try std.Io.Dir.cwd().realPathFileAlloc(std.testing.io, paths.zine_executable, allocator),
                .wasm_file = try std.Io.Dir.cwd().realPathFileAlloc(std.testing.io, paths.wasm_file, allocator),
                .site_directory = root,
                .api_directory = try std.fs.path.join(allocator, &.{ root, "prepared-api" }),
                .output_directory = try std.fs.path.join(allocator, &.{ root, "dist" }),
                .engine_stderr = .ignore,
            },
        };
    }

    fn deinit(self: *Fixture) void {
        self.temporary.cleanup();
        self.arena.deinit();
    }

    fn path(self: *Fixture, directory: []const u8, relative: []const u8) ![]const u8 {
        return std.fs.path.join(self.arena.allocator(), &.{ directory, relative });
    }

    fn prepare(self: *Fixture) !void {
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        try site.api.prepare(arena.allocator(), std.testing.io, self.api_input_directory, self.options.api_directory);
    }

    fn build(self: *Fixture) !site.website.Result {
        try self.prepare();
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        return site.website.build(arena.allocator(), std.testing.io, self.options);
    }

    fn initWithPrevious() !Fixture {
        var fixture = try init();
        errdefer fixture.deinit();
        _ = try fixture.build();
        try site.files.write(std.testing.io, try fixture.path(fixture.options.output_directory, "stale.html"), "Last valid build");
        return fixture;
    }

    fn expectFailure(self: *Fixture, expected: anyerror) !void {
        try std.testing.expectError(expected, self.build());
        const previous = try site.files.read(self.arena.allocator(), std.testing.io, try self.path(self.options.output_directory, "stale.html"));
        try std.testing.expectEqualStrings("Last valid build", previous);
        var entries = self.temporary.dir.iterate();
        while (try entries.next(std.testing.io)) |entry| try std.testing.expect(!std.mem.startsWith(u8, entry.name, ".zine-build-"));
    }
};

fn contains(source: []const u8, expected: []const u8) !void {
    if (std.mem.indexOf(u8, source, expected) == null) {
        std.debug.print("Missing text: {s}\n", .{expected});
        return error.TestExpectedEqual;
    }
}

fn excludes(source: []const u8, unexpected: []const u8) !void {
    try std.testing.expect(std.mem.indexOf(u8, source, unexpected) == null);
}

test "clean removes generated outputs and preserves authored files and caches" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    const generated = [_][]const u8{
        "dist/docs/api/index.html",
        "dist/docs/api/sources.tar.gz",
        "assets/catalog.js",
        "content/docs/examples.smd",
        "wasm/GuideExamples.zig",
        "wasm/guide-catalog.json",
    };
    const preserved = [_][]const u8{
        "content/docs/api/index.smd",
        "layouts/api.shtml",
        "tools/catalog-intro.smd",
        "assets/site.css",
        "wasm/main.zig",
        "wasm/descriptions.json",
        ".openai/hosting.json",
        ".zig-cache/keep",
        "zig-pkg/keep",
    };
    for (generated ++ preserved) |path| {
        try temporary.dir.createDirPath(io, std.fs.path.dirname(path).?);
        try temporary.dir.writeFile(io, .{ .sub_path = path, .data = "Keep original contents" });
    }
    try site.clean(io, temporary.dir);
    try site.clean(io, temporary.dir);
    for (generated ++ .{"dist"}) |path|
        try std.testing.expectError(error.FileNotFound, temporary.dir.statFile(io, path, .{}));
    for (preserved) |path| {
        const contents = try temporary.dir.readFileAlloc(io, path, std.testing.allocator, .limited(64));
        defer std.testing.allocator.free(contents);
        try std.testing.expectEqualStrings("Keep original contents", contents);
    }
}

test "clean removes output symlinks without deleting their targets" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    try temporary.dir.createDir(io, "outside", .default_dir);
    try temporary.dir.writeFile(io, .{ .sub_path = "outside/keep", .data = "Preserved" });
    try temporary.dir.symLink(io, "outside", "dist", .{ .is_directory = true });
    try site.clean(io, temporary.dir);
    try std.testing.expectError(error.FileNotFound, temporary.dir.statFile(io, "dist", .{
        .follow_symlinks = false,
    }));
    const contents = try temporary.dir.readFileAlloc(io, "outside/keep", std.testing.allocator, .limited(64));
    defer std.testing.allocator.free(contents);
    try std.testing.expectEqualStrings("Preserved", contents);
}

test "generated pages retain their routes and local references" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try site.website.validate(arena.allocator(), std.testing.io, "dist");
    try std.testing.expectEqual(@as(usize, 8), result.pages);
    try std.testing.expectEqual(@as(usize, 157), result.references);

    const allocator = arena.allocator();
    // Dynamic imports and canvas textures must be explicitly published by Zine.
    for ([_][]const u8{ "tree.js", "ast-leaf.webp", "ast-forest.webp", "ast-bark.webp", "ast-roots.webp" }) |asset| {
        try std.testing.expect(try site.files.exists(std.testing.io, try std.fs.path.join(allocator, &.{ "dist", asset })));
    }
    for ([_][]const u8{ "", "docs", "docs/getting-started", "docs/examples", "docs/api", "blog", "blog/static-zig-playground", "examples" }) |route| {
        const html = try site.files.read(allocator, std.testing.io, try std.fs.path.join(allocator, &.{ "dist", route, "index.html" }));
        var classes = site.website.attributes(html, "class");
        var active: usize = 0;
        while (classes.next()) |class| {
            var names = std.mem.tokenizeScalar(u8, class, ' ');
            while (names.next()) |name| if (std.mem.eql(u8, name, "active")) {
                active += 1;
            };
        }
        try std.testing.expectEqual(@as(usize, 1), active);
        try excludes(html, "$page.");
        try excludes(html, "<extend");
    }
    for (try site.files.list(allocator, std.testing.io, "content")) |file| try std.testing.expect(!std.mem.endsWith(u8, file, ".shtml"));
    try std.testing.expect(try site.files.exists(std.testing.io, "zine.ziggy"));
}

test "home and playground retain their distinct controls and example links" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const home = try site.files.read(allocator, std.testing.io, "dist/index.html");
    const playground = try site.files.read(allocator, std.testing.io, "dist/examples/index.html");
    const guide = try site.files.read(allocator, std.testing.io, "dist/docs/examples/index.html");
    try contains(home, "id=\"ast-tree\"");
    try contains(home, "id=\"tree-legend\"");
    try excludes(playground, "id=\"ast-tree\"");
    for ([_][]const u8{ "rotation-button", "rotation-status", "rotation-progress", "previous-example-button", "next-example-button", "example-description", "example-guide", "api-output", "input-error", "example-select", "copy-button", "download-button", "share-button", "reset-button", "zig-output", "output-filename", "toast" }) |identifier|
        try contains(home, try std.fmt.allocPrint(allocator, "id=\"{s}\"", .{identifier}));
    for ([_][]const u8{ "json-input", "input-lines", "input-error", "example-select", "copy-button", "download-button", "share-button", "tab-zig", "tab-api", "tab-ast", "tab-tokens", "panel-zig", "panel-api", "panel-ast", "panel-tokens", "node-rows", "token-rows", "toast" }) |identifier|
        try contains(playground, try std.fmt.allocPrint(allocator, "id=\"{s}\"", .{identifier}));
    for ([_][]const u8{ "src=\"/zast-site/playground.js\"", "href=\"/zast-site/docs/api/\"", "open-playground", "Zig API example, read only" }) |text| try contains(home, text);
    for ([_][]const u8{ "id=\"json-input\"", "description.json", "workspace-vines" }) |text| try excludes(home, text);
    for ([_][]const u8{ "rotation-button", "previous-example-button", "next-example-button" }) |identifier|
        try excludes(playground, try std.fmt.allocPrint(allocator, "id=\"{s}\"", .{identifier}));
    try excludes(playground, "workspace-vines");
    try contains(try site.files.read(allocator, std.testing.io, "dist/docs/index.html"), "href=\"/zast-site/docs/api/\"");
    try std.testing.expectEqual(@as(usize, 24), std.mem.count(u8, guide, ">Try this example</a>"));
    var links = site.website.attributes(guide, "href");
    var example_links: usize = 0;
    while (links.next()) |link| if (std.mem.startsWith(u8, link, "../../examples/?example=")) {
        try std.testing.expect(!std.mem.endsWith(u8, link, "/"));
        example_links += 1;
    };
    try std.testing.expectEqual(@as(usize, 24), example_links);
}

test "Zine escapes page metadata" {
    var fixture = try Fixture.init();
    defer fixture.deinit();
    try site.files.write(std.testing.io, try fixture.path(fixture.content_directory, "escaped.smd"),
        \\---
        \\.title = "\"<title>",
        \\.description = "\"<description>",
        \\.date = .date("2026-10-22T00:00:00"),
        \\.layout = "content.shtml",
        \\.custom = .{ .kind = "article", .navigation = "docs" },
        \\---
        \\# Content
    );
    _ = try fixture.build();
    const html = try site.files.read(fixture.arena.allocator(), std.testing.io, try fixture.path(fixture.options.output_directory, "escaped/index.html"));
    try contains(html, "&lt;title&gt;");
    try contains(html, "content=\"&quot;&lt;description&gt;\"");
    try excludes(html, "<title>\"<title>");
}

test "API transport is lossless and preserves the viewer hooks and shared theme" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const native_wasm = try site.files.read(allocator, std.testing.io, try std.fs.path.join(allocator, &.{ paths.api_directory, "main.wasm" }));
    try std.testing.expectEqualSlices(u8, native_wasm, try site.files.read(allocator, std.testing.io, "dist/docs/api/main.wasm"));
    const archive = try site.files.read(allocator, std.testing.io, "dist/docs/api/sources.tar.gz");
    var reader: std.Io.Reader = .fixed(archive);
    const window = try allocator.alloc(u8, std.compress.flate.max_window_len);
    var decompressor: std.compress.flate.Decompress = .init(&reader, .gzip, window);
    const original = try site.files.read(allocator, std.testing.io, try std.fs.path.join(allocator, &.{ paths.api_directory, "sources.tar" }));
    try std.testing.expectEqualSlices(u8, original, try decompressor.reader.allocRemaining(allocator, .limited(64 * 1024 * 1024)));
    try std.testing.expect(archive.len < original.len);
    try contains(original, "EnumDeclaration.zig");
    try std.testing.expect(!try site.files.exists(std.testing.io, "dist/docs/api/sources.tar"));
    try contains(try site.files.read(allocator, std.testing.io, "dist/docs/api/main.js"), "new DecompressionStream(\"gzip\")");
    const html = try site.files.read(allocator, std.testing.io, "dist/docs/api/index.html");
    for ([_][]const u8{ "href=\"sources.tar.gz\"", "href=\"/zast-site/site.css\"", "href=\"/zast-site/api.css\"", "class=\"site-header\"", "class=\"site-footer page-width\"", "data-page=\"api\"", "src=\"/zast-site/site.js\"" }) |text| try contains(html, text);
    try excludes(html, "<style");
    try excludes(html, "src=\"/zast-site/playground.js\"");
    const native_html = try site.files.read(allocator, std.testing.io, try std.fs.path.join(allocator, &.{ paths.api_directory, "index.html" }));
    var identifiers = site.website.attributes(native_html, "id");
    while (identifiers.next()) |identifier| if (!std.mem.eql(u8, identifier, "text")) {
        try contains(html, try std.fmt.allocPrint(allocator, "id=\"{s}\"", .{identifier}));
    };
}

test "broken links and fragments preserve the prior site and clean staging" {
    var fixture = try Fixture.initWithPrevious();
    defer fixture.deinit();
    const article = try fixture.path(fixture.content_directory, "blog/index.smd");
    const original = try site.files.read(fixture.arena.allocator(), std.testing.io, article);
    try site.files.write(std.testing.io, article, try std.fmt.allocPrint(fixture.arena.allocator(), "{s}\n```=html\n<a href=\"/zast-site/missing-page/\">Broken</a>\n```\n", .{original}));
    try fixture.expectFailure(error.MissingLocalReference);
    try site.files.write(std.testing.io, article, try std.fmt.allocPrint(fixture.arena.allocator(), "{s}\n```=html\n<a href=\"/zast-site/docs/#missing-heading\">Broken</a>\n```\n", .{original}));
    try fixture.expectFailure(error.MissingFragment);
    try site.files.write(std.testing.io, article, try std.fmt.allocPrint(fixture.arena.allocator(), "{s}\n```=html\n<a href=\"/zast-site/docs/api/#zast.EnumDeclaration\">Enum</a>\n```\n", .{original}));
    try std.testing.expectEqual(@as(usize, 8), (try fixture.build()).pages);
    try std.testing.expect(!try site.files.exists(std.testing.io, try fixture.path(fixture.options.output_directory, "stale.html")));
}

test "duplicate routes and content collisions preserve prior output" {
    var fixture = try Fixture.initWithPrevious();
    defer fixture.deinit();
    const document = try site.files.read(fixture.arena.allocator(), std.testing.io, try fixture.path(fixture.content_directory, "docs/index.smd"));
    const duplicate = try fixture.path(fixture.content_directory, "docs.smd");
    try site.files.write(std.testing.io, duplicate, document);
    try fixture.expectFailure(error.DuplicatePageRoute);
    try std.Io.Dir.cwd().deleteFile(std.testing.io, duplicate);
    const asset = try fixture.path(fixture.content_directory, "site.css");
    try site.files.write(std.testing.io, asset, "collision");
    try fixture.expectFailure(error.AssetCollision);
    try std.Io.Dir.cwd().deleteFile(std.testing.io, asset);
    try site.files.write(std.testing.io, try fixture.path(fixture.options.site_directory, "assets/docs/api/main.js"), "collision");
    try fixture.expectFailure(error.GeneratedAssetCollision);
}

test "unsupported viewer layout and transport fail closed" {
    var fixture = try Fixture.initWithPrevious();
    defer fixture.deinit();
    const allocator = fixture.arena.allocator();
    const index = try fixture.path(fixture.api_input_directory, "index.html");
    const html = try site.files.read(allocator, std.testing.io, index);
    try site.files.write(std.testing.io, index, try site.files.replace(allocator, html, "<body>", "<body class=\"changed-upstream-layout\">"));
    try fixture.expectFailure(error.UnsupportedViewerLayout);
    try site.files.write(std.testing.io, index, html);
    const script = try fixture.path(fixture.api_input_directory, "main.js");
    const source = try site.files.read(allocator, std.testing.io, script);
    try site.files.write(std.testing.io, script, try site.files.replace(allocator, source, "fetch(\"sources.tar\")", "fetch(\"different-archive.tar\")"));
    try fixture.expectFailure(error.UnsupportedViewerTransport);
}

test "missing API assets and broken viewer references preserve prior output" {
    var fixture = try Fixture.initWithPrevious();
    defer fixture.deinit();
    const allocator = fixture.arena.allocator();
    const wasm = try fixture.path(fixture.api_input_directory, "main.wasm");
    const binary = try site.files.read(allocator, std.testing.io, wasm);
    try site.files.write(std.testing.io, wasm, "");
    try fixture.expectFailure(error.MissingApiAsset);
    try site.files.write(std.testing.io, wasm, binary);
    const archive = try fixture.path(fixture.api_input_directory, "sources.tar");
    const source = try site.files.read(allocator, std.testing.io, archive);
    try std.Io.Dir.cwd().deleteFile(std.testing.io, archive);
    try fixture.expectFailure(error.FileNotFound);
    try site.files.write(std.testing.io, archive, source);
    const index = try fixture.path(fixture.api_input_directory, "index.html");
    const html = try site.files.read(allocator, std.testing.io, index);
    try site.files.write(std.testing.io, index, try site.files.replace(allocator, html, "</body>", "<script src=\"missing-api.js\"></script>\n</body>"));
    try fixture.expectFailure(error.MissingLocalReference);
    try site.files.write(std.testing.io, index, try site.files.replace(allocator, html, "</body>", "<a href=\"#zast.Expression\">Expression</a>\n</body>"));
    _ = try fixture.build();
}

test "duplicate IDs and extra headings fail validation" {
    var fixture = try Fixture.initWithPrevious();
    defer fixture.deinit();
    const article = try fixture.path(fixture.content_directory, "blog/index.smd");
    const source = try site.files.read(fixture.arena.allocator(), std.testing.io, article);
    try site.files.write(std.testing.io, article, try std.fmt.allocPrint(fixture.arena.allocator(), "{s}\n```=html\n<div id=\"site-content\"></div>\n```\n", .{source}));
    try fixture.expectFailure(error.DuplicateHtmlId);
    try site.files.write(std.testing.io, article, try std.fmt.allocPrint(fixture.arena.allocator(), "{s}\n```=html\n<h1>Another title</h1>\n```\n", .{source}));
    try fixture.expectFailure(error.InvalidHeadingCount);
}

test "catalogue descriptions and guide sync retain all examples and generated Zig" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const entries = try site.catalog.load(allocator, std.testing.io);
    try std.testing.expectEqual(@as(usize, 24), entries.len);
    for (entries[0..15], 1..) |entry, number| try std.testing.expectEqual(number, entry.number.?);
    for (entries[0..14]) |entry| {
        try std.testing.expect(entry.input.object.contains("declarations"));
        try std.testing.expect(!entry.input.object.contains("name"));
    }
    try std.testing.expect(entries[14].input.object.contains("schema"));
    for (entries[15..18]) |entry|
        try std.testing.expect(entry.input.object.contains("declarations"));
    // Reconstruct the guide from the generated descriptions, independent of a
    // sibling checkout. Its public sync path uses the same compile operation.
    var guide: std.Io.Writer.Allocating = .init(allocator);
    for (entries[0..13]) |entry| {
        const body = try site.files.replace(allocator, entry.body.?, "context, output_name,", try std.fmt.allocPrint(allocator, "context, \"{s}\",", .{entry.name.?}));
        try guide.writer.print("\n## {d}. {s}\n\n```zig\n{s}```\n\n```zig\n{s}```\n", .{ entry.number.?, entry.title, body, entry.expected.? });
    }
    const compiled = try site.catalog.compileGuide(allocator, guide.written());
    const snapshot = try std.json.parseFromSliceLeaky([]const site.catalog.Entry, allocator, compiled.snapshot, .{});
    try std.testing.expectEqual(@as(usize, 13), snapshot.len);
    try contains(compiled.zig, "const output_name = name orelse \"answer\";");
    const terminated = try allocator.dupeSentinel(u8, compiled.zig, 0);
    var tree = try std.zig.Ast.parse(allocator, terminated, .{});
    defer tree.deinit(allocator);
    try std.testing.expectEqual(@as(usize, 0), tree.errors.len);
    try std.testing.expectEqualStrings(compiled.zig, try tree.renderAlloc(allocator));
    try std.testing.expectError(error.MissingGuideSection, site.catalog.compileGuide(allocator, ""));
    try std.testing.expectError(error.MissingGuideSnippet, site.catalog.compileGuide(allocator, "\n## 1. Missing\n"));
    const missing_root = try site.files.replace(allocator, guide.written(), "context, \"answer\",", "context, invalid_name,");
    try std.testing.expectError(error.MissingRootEmission, site.catalog.compileGuide(allocator, missing_root));
}

test "validation rejects ambiguous URLs escaping paths and source symlinks" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    for ([_][]const u8{ "/../outside", "/docs/../../outside" }) |path|
        try std.testing.expectError(error.PathEscapesRoot, site.website.localPath(allocator, path));
    for ([_][]const u8{ "/%", "/%xx", "/%00", "/%ff", "/%5c.." }) |url|
        try std.testing.expectError(error.InvalidUrl, site.website.decode(allocator, url));
    try std.testing.expectEqualStrings("/docs/?example=enum", try site.website.decode(allocator, "/docs/?example=enum"));
    for ([_]struct { url: []const u8, prefix: []const u8, relative: []const u8 }{
        .{ .url = "/zast-site/", .prefix = "zast-site", .relative = "" },
        .{ .url = "/zast-site/docs/api/", .prefix = "zast-site", .relative = "docs/api" },
        .{ .url = "/%7aast-site/docs/../icons/file.svg", .prefix = "zast-site", .relative = "icons/file.svg" },
        .{ .url = "/docs/api/", .prefix = "", .relative = "docs/api" },
    }) |route| try std.testing.expectEqualStrings(
        route.relative,
        try site.website.sitePath(allocator, route.url, route.prefix),
    );
    for ([_][]const u8{
        "/zast-siteevil/docs/", "/docs/", "/zast-site/../outside", "/zast-site/%2e%2e/outside",
    }) |url| try std.testing.expectError(
        error.MissingLocalReference,
        site.website.sitePath(allocator, url, "zast-site"),
    );
    try std.testing.expectError(
        error.PathEscapesRoot,
        site.website.sitePath(allocator, "/zast-site/../../outside", "zast-site"),
    );

    try temporary.dir.createDir(std.testing.io, "docs", .default_dir);
    try temporary.dir.symLink(std.testing.io, "docs", "alias", .{ .is_directory = true });
    const root = try temporary.dir.realPathFileAlloc(std.testing.io, ".", allocator);
    try std.testing.expectError(error.UnsupportedFileKind, site.files.list(allocator, std.testing.io, root));
}

fn httpRequest(allocator: std.mem.Allocator, address: std.Io.net.IpAddress, method: []const u8, target: []const u8) ![]const u8 {
    const io = std.testing.io;
    const timeout: std.Io.Timeout = .{ .duration = .{ .raw = .fromSeconds(5), .clock = .awake } };
    // Zig 0.17.0's POSIX backend has no connect-timeout implementation. This
    // local listener already exists; bound each response read instead.
    const stream = try address.connect(io, .{ .mode = .stream });
    defer stream.close(io);
    var write_buffer: [1024]u8 = undefined;
    var writer = stream.writer(io, &write_buffer);
    try writer.interface.print("{s} {s} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", .{ method, target });
    try writer.interface.flush();
    var response: std.Io.Writer.Allocating = .init(allocator);
    var expected_length: ?usize = null;
    var read_buffer: [8192]u8 = undefined;
    var chunks = [_][]u8{&read_buffer};
    while (true) {
        const result = try io.operateTimeout(.{ .net_read = .{ .socket_handle = stream.socket.handle, .data = &chunks } }, timeout);
        const count = (try result.net_read).data_len;
        if (count == 0) break;
        try response.writer.writeAll(read_buffer[0..count]);
        if (expected_length == null) if (std.mem.indexOf(u8, response.written(), "\r\n\r\n")) |header_end| {
            expected_length = header_end + 4;
            if (!std.mem.eql(u8, method, "HEAD")) {
                var headers = std.mem.splitSequence(u8, response.written()[0..header_end], "\r\n");
                while (headers.next()) |header| {
                    const colon = std.mem.indexOfScalar(u8, header, ':') orelse continue;
                    if (std.ascii.eqlIgnoreCase(header[0..colon], "content-length"))
                        expected_length.? += try std.fmt.parseInt(usize, std.mem.trim(u8, header[colon + 1 ..], " "), 10);
                }
            }
        };
        if (expected_length) |length| if (response.written().len >= length) break;
    }
    return response.toOwnedSlice();
}

test "Zine frontmatter layout directive and process failures preserve the prior site" {
    var fixture = try Fixture.initWithPrevious();
    defer fixture.deinit();
    const allocator = fixture.arena.allocator();
    const article = try fixture.path(fixture.content_directory, "blog/index.smd");
    const source = try site.files.read(allocator, std.testing.io, article);
    for ([_][2][]const u8{
        .{ ".date = .date(\"2026-10-21T00:00:00\")", ".date = \"invalid-date\"" },
        .{ ".layout = \"content.shtml\"", ".layout = \"missing.shtml\"" },
    }) |change| {
        try site.files.write(std.testing.io, article, try site.files.replace(allocator, source, change[0], change[1]));
        try fixture.expectFailure(error.ZineFailed);
    }
    try site.files.write(std.testing.io, article, try std.fmt.allocPrint(allocator, "{s}\n[]($video.nonexistent())\n", .{source}));
    try fixture.expectFailure(error.ZineFailed);
    try site.files.write(std.testing.io, article, source);
    const layout = try fixture.path(fixture.options.site_directory, "layouts/content.shtml");
    const template = try site.files.read(allocator, std.testing.io, layout);
    try site.files.write(std.testing.io, layout, "<extend template=\"base.shtml\"><div id=\"site-content\">wrong block</div>");
    try fixture.expectFailure(error.ZineFailed);
    try site.files.write(std.testing.io, layout, template);
    fixture.options.zine_executable = try std.Io.Dir.cwd().realPathFileAlloc(std.testing.io, paths.interrupted_engine_executable, allocator);
    try fixture.expectFailure(error.ZineFailed);
    fixture.options.zine_executable = try fixture.path(fixture.options.site_directory, "missing-engine");
    try fixture.expectFailure(error.FileNotFound);
}

const LiveServer = struct {
    child: std.process.Child,
    address: std.Io.net.IpAddress,

    fn start(allocator: std.mem.Allocator, options: site.website.Options) !LiveServer {
        const io = std.testing.io;
        // Reserve an ephemeral port rather than conflicting with the user's preview.
        var reservation = try (std.Io.net.IpAddress{ .ip4 = .loopback(0) }).listen(io, .{});
        const address = reservation.socket.address;
        reservation.deinit(io);
        const command = try site.website.arguments(allocator, io, options, null);
        const mutable_command = try allocator.dupe([]const u8, command);
        for (mutable_command) |*argument| if (std.mem.eql(u8, argument.*, "--port=1990")) {
            argument.* = try std.fmt.allocPrint(allocator, "--port={d}", .{address.getPort()});
        };
        var child = try std.process.spawn(io, .{ .argv = mutable_command, .cwd = .{ .path = options.site_directory }, .stderr = .ignore });
        errdefer child.kill(io);
        for (0..100) |_| {
            const response = httpRequest(allocator, address, "GET", "/") catch {
                try io.sleep(.fromMilliseconds(50), .awake);
                continue;
            };
            try contains(response, "200 OK");
            return .{ .child = child, .address = address };
        }
        return error.PreviewDidNotStart;
    }
};

test "Zine preview serves routes HEAD gzip bytes and concurrent connections" {
    var fixture = try Fixture.init();
    defer fixture.deinit();
    try fixture.prepare();
    const allocator = fixture.arena.allocator();
    var server = try LiveServer.start(allocator, fixture.options);
    defer server.child.kill(std.testing.io);
    const idle = try server.address.connect(std.testing.io, .{ .mode = .stream });
    defer idle.close(std.testing.io);
    const home = try httpRequest(allocator, server.address, "GET", "/");
    try contains(home, "200 OK");
    try contains(home, "content-type: text/html");
    try contains(home, "/__zine/zinereload.js");
    try contains(home, "data-wasm=\"/playground.wasm\"");
    try contains(home, "src=\"/playground.js\"");
    try excludes(home, "/zast-site/");
    const redirect = try httpRequest(allocator, server.address, "GET", "/docs?example=enum");
    try contains(redirect, "303 See Other");
    try contains(redirect, "location: /docs/?example=enum");
    const head = try httpRequest(allocator, server.address, "HEAD", "/playground.wasm");
    try contains(head, "content-type: application/wasm");
    const body_start = (std.mem.indexOf(u8, head, "\r\n\r\n") orelse return error.MissingHttpHeaders) + 4;
    try std.testing.expectEqual(body_start, head.len);
    const binary = try site.files.read(allocator, std.testing.io, paths.wasm_file);
    try contains(head, try std.fmt.allocPrint(allocator, "content-length: {d}", .{binary.len}));
    const compressed = try httpRequest(allocator, server.address, "GET", "/docs/api/sources.tar.gz");
    const header_end = std.mem.indexOf(u8, compressed, "\r\n\r\n") orelse return error.MissingHttpHeaders;
    try contains(compressed[0..header_end], "content-type: application/gzip");
    try excludes(compressed[0..header_end], "content-encoding");
    try std.testing.expectEqualSlices(u8, try site.files.read(allocator, std.testing.io, try fixture.path(fixture.options.api_directory, "sources.tar.gz")), compressed[header_end + 4 ..]);
    try contains(try httpRequest(allocator, server.address, "POST", "/"), "200 OK");
    try contains(try httpRequest(allocator, server.address, "GET", "/missing/"), "404 Not Found");

    const article = try fixture.path(fixture.content_directory, "blog/index.smd");
    const source = try site.files.read(allocator, std.testing.io, article);
    try site.files.write(std.testing.io, article, try std.fmt.allocPrint(allocator, "{s}\nLive reload fixture.\n", .{source}));
    for (0..100) |_| {
        try std.testing.io.sleep(.fromMilliseconds(50), .awake);
        const updated = try httpRequest(allocator, server.address, "GET", "/blog/");
        if (std.mem.indexOf(u8, updated, "Live reload fixture.") != null) return;
    }
    return error.LiveReloadDidNotUpdate;
}

test "pinned Zine traversal panic is isolated to the loopback preview process" {
    var fixture = try Fixture.init();
    defer fixture.deinit();
    try fixture.prepare();
    var server = try LiveServer.start(fixture.arena.allocator(), fixture.options);
    defer server.child.kill(std.testing.io);
    _ = httpRequest(fixture.arena.allocator(), server.address, "GET", "/../outside") catch "";
    try std.testing.expect(!(try server.child.wait(std.testing.io)).success());
}
