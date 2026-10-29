//! Build-graph regression tests using the real Tools adapter and native coordinator.
//! Requires the `site` module, `paths.api_directory`, `paths.zig_executable`,
//! and the site root as the working directory. Fixtures have no Zine dependency.
const std = @import("std");
const site = @import("site");
const paths = @import("paths");

const Fixture = struct {
    temporary: std.testing.TmpDir,
    arena: std.heap.ArenaAllocator,
    directory: []const u8,

    fn init() !Fixture {
        var temporary = std.testing.tmpDir(.{});
        errdefer temporary.cleanup();
        var fixture: Fixture = .{
            .temporary = temporary,
            .arena = std.heap.ArenaAllocator.init(std.testing.allocator),
            .directory = &.{},
        };
        errdefer fixture.arena.deinit();
        const allocator = fixture.arena.allocator();
        fixture.directory = try temporary.dir.realPathFileAlloc(std.testing.io, ".", allocator);
        try site.files.copyTree(allocator, std.testing.io, "tools", try fixture.path("tools"));
        try site.files.copyTree(
            allocator,
            std.testing.io,
            paths.api_directory,
            try fixture.path("compiler-docs"),
        );
        // API preparation compresses opaque bytes; a small fixture is sufficient.
        try fixture.write("compiler-docs/sources.tar", "Source archive fixture\n");
        try fixture.write("build.zig.zon",
            \\.{
            \\    .name = .zast_site,
            \\    .version = "0.0.0",
            \\    .fingerprint = 0x20b2f643304267ef,
            \\    .paths = .{ "" },
            \\}
            \\
        );
        try fixture.write("build.zig",
            \\const std = @import("std");
            \\const Tools = @import("tools/Tools.zig");
            \\pub fn build(builder: *std.Build) void {
            \\    const tools = Tools.init(builder);
            \\    const prepare = tools.addRun(.{
            \\        .@"prepare-api" = builder.path("compiler-docs"),
            \\    }, &.{});
            \\    const output = prepare.addOutputDirectoryArg2("api", .{ .make_absolute = true });
            \\    prepare.setName("prepare-api-fixture");
            \\    builder.getInstallStep().dependOn(&builder.addInstallDirectory(.{
            \\        .source_dir = output,
            \\        .install_dir = .prefix,
            \\        .install_subdir = "api",
            \\    }).step);
            \\}
            \\
        );
        return fixture;
    }

    fn deinit(self: *Fixture) void {
        self.temporary.cleanup();
        self.arena.deinit();
    }

    fn path(self: *Fixture, relative: []const u8) ![]const u8 {
        return std.fs.path.join(self.arena.allocator(), &.{ self.directory, relative });
    }

    fn read(self: *Fixture, relative: []const u8) ![]const u8 {
        return site.files.read(self.arena.allocator(), std.testing.io, try self.path(relative));
    }

    fn write(self: *Fixture, relative: []const u8, contents: []const u8) !void {
        try site.files.write(std.testing.io, try self.path(relative), contents);
    }

    fn run(self: *Fixture, cached: ?bool) !void {
        const allocator = self.arena.allocator();
        var environment = try std.testing.environ.createMap(allocator);
        // Never share the outer build's local cache with a nested build runner.
        try environment.put("ZIG_LOCAL_CACHE_DIR", try self.path(".zig-cache"));
        const result = try std.process.run(self.arena.allocator(), std.testing.io, .{
            .argv = &.{
                paths.zig_executable, "build", "--summary", "all", "--color", "off", "-j2",
            },
            .cwd = .{ .path = self.directory },
            .environ_map = &environment,
            .stderr_limit = .limited(1024 * 1024),
            .stdout_limit = .limited(1024 * 1024),
        });
        const expected = if (cached) |reuse|
            if (reuse) "prepare-api-fixture cached" else "prepare-api-fixture success"
        else
            "prepare-api-fixture ";
        if (!result.term.success() or std.mem.indexOf(u8, result.stderr, expected) == null) {
            std.debug.print("Expected {s}:\n{s}\n{s}\n", .{
                expected, result.stdout, result.stderr,
            });
            return error.UnexpectedBuildResult;
        }
    }
};

test "API preparation caches unchanged inputs and tracks every compiler document" {
    var fixture = try Fixture.init();
    defer fixture.deinit();
    try fixture.run(false);
    try fixture.run(true);
    const allocator = fixture.arena.allocator();
    for ([_]struct { input: []const u8, output: []const u8 }{
        .{ .input = "index.html", .output = "body.html" },
        .{ .input = "main.js", .output = "main.js" },
        .{ .input = "main.wasm", .output = "main.wasm" },
        .{ .input = "sources.tar", .output = "sources.tar.gz" },
    }) |document| {
        errdefer std.debug.print("API cache input: {s}\n", .{document.input});
        const input = try std.fs.path.join(allocator, &.{ "compiler-docs", document.input });
        const output = try std.fs.path.join(allocator, &.{ "zig-out/api", document.output });
        const original_input = try fixture.read(input);
        const original_output = try fixture.read(output);
        const changed = if (std.mem.eql(u8, document.input, "index.html"))
            try site.files.replace(
                allocator,
                original_input,
                "<body>",
                "<body><!-- cache input -->",
            )
        else
            try std.mem.concat(allocator, u8, &.{ original_input, "\n// cache input\n" });
        try fixture.write(input, changed);
        try fixture.run(false);
        try std.testing.expect(!std.mem.eql(u8, original_output, try fixture.read(output)));
        try fixture.run(true);
        try fixture.write(input, original_input);
        // A manifest may retain only the most recent version of these fixed paths.
        try fixture.run(null);
        try std.testing.expectEqualStrings(original_output, try fixture.read(output));
    }

    // Change executable behavior, not a comment that Zig could compile identically.
    const original_tool = try fixture.read("tools/api.zig");
    try fixture.write("tools/api.zig", try site.files.replace(
        allocator,
        original_tool,
        "    const html =",
        "    std.log.warn(\"API cache executable changed\", .{});\n    const html =",
    ));
    try fixture.run(false);
    try fixture.run(true);
}
