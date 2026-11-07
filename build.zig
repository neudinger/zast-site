//! zvm-lock: 0.17.0
//! Build the Zast website with its pinned Zine engine.
const std = @import("std");
const manifest = @import("build.zig.zon");
const Tools = @import("tools/Tools.zig");
const Build = std.Build;

comptime {
    const required_version = manifest.minimum_zig_version;
    if (!std.mem.eql(u8, @import("builtin").zig_version_string, required_version)) {
        @compileError("This site requires Zig " ++ required_version ++
            "; run `zvm run " ++ required_version ++ " build`.");
    }
}

pub fn build(builder: *Build) void {
    const zine = builder.dependency("zine", .{
        .target = builder.graph.host,
        .optimize = .ReleaseFast,
        .@"no-git-version" = true,
        .highlight = false,
    }).artifact("zine");

    const zast = builder.dependency("zast", .{
        .target = builder.graph.host,
        .optimize = .Debug,
    });
    const tools = Tools.init(builder);
    const clean = tools.addRun(.clean, &.{});
    const sync = tools.addRun(.{ .@"sync-examples" = zast.path(".") }, &.{});
    const catalog = tools.addRun(.catalog, &.{&sync.step});

    builder.step("clean", "Remove the generated website and guide snapshots").dependOn(&clean.step);
    builder.step("sync-examples", "Refresh the guide snapshots").dependOn(&sync.step);
    builder.step("catalog", "Generate the copyable example catalogue").dependOn(&catalog.step);

    const wasm = tools.addCompile(.wasm, &.{&sync.step});
    const wasm_step = builder.step("wasm", "Build the browser generator and catalogue");
    wasm_step.dependOn(&wasm.step);
    wasm_step.dependOn(&catalog.step);

    const release = builder.addRunArtifact(zine);
    release.setCwd(builder.path("."));
    release.has_side_effects = true;
    release.addArgs(&.{ "release", "--output=dist", "--force" });
    release.step.dependOn(&catalog.step);
    release.addArg("--build-asset=playground");
    release.addFileArg2(wasm.getEmittedBin(), .{});
    release.addArg("--install-always=playground.wasm");
    builder.getInstallStep().dependOn(&release.step);

    const tests = builder.addSystemCommand(&.{ "node", "tests/stage.cjs" });
    tests.setCwd(builder.path("."));
    tests.setEnvironmentVariable("ZIG", builder.graph.zig_exe);
    tests.addDirectoryArg2(zast.path("."), .{ .make_absolute = true });
    tests.step.dependOn(&release.step);
    builder.step("test", "Build and test the website").dependOn(&tests.step);
}
