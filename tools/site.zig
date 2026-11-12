//! Native catalogue, compiler-documentation adaptation, and Zine coordination.
const std = @import("std");
pub const catalog = @import("catalog.zig");
pub const website = @import("website.zig");
pub const api = @import("api.zig");
pub const files = @import("files.zig");

pub const std_options: std.Options = .{ .log_level = .warn };

/// Remove generated site outputs relative to directory; missing outputs are harmless.
/// Authored sources, hosting configuration, dependencies, and caches are preserved.
pub fn clean(io: std.Io, directory: std.Io.Dir) !void {
    for ([_][]const u8{
        "dist",
        "assets/catalog.js",
        "content/docs/examples.smd",
        "wasm/GuideExamples.zig",
        "wasm/guide-catalog.json",
    }) |path| try directory.deleteTree(io, path);
}

/// Resolve the branch before passing the exact commit URL to Zig's package manager.
fn updateZast(allocator: std.mem.Allocator, io: std.Io, zig_executable: []const u8) !void {
    const repository = "https://github.com/neudinger/zast";
    const branch = "refs/heads/main";
    const resolved = try std.process.run(allocator, io, .{
        .argv = &.{ "git", "ls-remote", "--exit-code", repository, branch },
        .stdout_limit = .limited(4096),
        .stderr_limit = .limited(64 * 1024),
    });
    defer allocator.free(resolved.stdout);
    defer allocator.free(resolved.stderr);
    if (!resolved.term.success()) {
        std.debug.print("{s}", .{resolved.stderr});
        return error.ZastRefLookupFailed;
    }

    const line = std.mem.trimEnd(u8, resolved.stdout, "\r\n");
    const commit, const ref = std.mem.cutScalar(u8, line, '\t') orelse return error.InvalidZastRef;
    if (commit.len != 40 or !std.mem.eql(u8, ref, branch)) return error.InvalidZastRef;
    for (commit) |digit| if (!std.ascii.isHex(digit)) return error.InvalidZastRef;

    const url = try std.fmt.allocPrint(allocator, "git+{s}#{s}", .{ repository, commit });
    defer allocator.free(url);
    var fetch = try std.process.spawn(io, .{
        .argv = &.{ zig_executable, "fetch", "--save-exact=zast", url },
    });
    defer fetch.kill(io);
    if (!(try fetch.wait(io)).success()) return error.ZastFetchFailed;
}

pub fn main(init: std.process.Init) !void {
    var arena = std.heap.ArenaAllocator.init(init.gpa);
    defer arena.deinit();
    const allocator = arena.allocator();
    const arguments = try init.minimal.args.toSlice(allocator);
    const Command = enum {
        clean,
        catalog,
        @"update-zast",
        @"sync-examples",
        @"prepare-api",
        build,
        serve,
    };
    if (arguments.len < 2) return error.ExpectedCommand;
    const command = std.meta.stringToEnum(Command, arguments[1]) orelse return error.UnknownCommand;
    switch (command) {
        .clean => {
            if (arguments.len != 2) return error.UnexpectedArguments;
            try clean(init.io, .cwd());
        },
        .catalog => {
            if (arguments.len != 2) return error.UnexpectedArguments;
            try catalog.build(allocator, init.io);
        },
        .@"update-zast" => {
            if (arguments.len != 3) return error.ExpectedZigExecutable;
            try updateZast(allocator, init.io, arguments[2]);
        },
        .@"sync-examples" => {
            if (arguments.len != 3) return error.ExpectedLibraryDirectory;
            try catalog.sync(allocator, init.io, arguments[2]);
        },
        .@"prepare-api" => {
            if (arguments.len != 4) return error.ExpectedApiInputAndOutputDirectories;
            try api.prepare(allocator, init.io, arguments[2], arguments[3]);
        },
        .build, .serve => {
            if (arguments.len != 5) return error.ExpectedZineWasmAndApiPaths;
            const options: website.Options = .{ .zine_executable = arguments[2], .wasm_file = arguments[3], .api_directory = arguments[4] };
            if (command == .serve) return website.serve(allocator, init.io, options);
            const result = try website.build(allocator, init.io, options);
            std.debug.print("Built {d} pages with {d} local references using Zine.\n", .{ result.pages, result.references });
        },
    }
}
