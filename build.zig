//! zvm-lock: 0.17.0
//! Build the Zast website with its pinned Zine engine.
const std = @import("std");
const manifest = @import("build.zig.zon");
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

    const release = builder.addRunArtifact(zine);
    release.setCwd(builder.path("."));
    release.has_side_effects = true;
    release.addArgs(&.{ "release", "--output=dist", "--force" });
    builder.getInstallStep().dependOn(&release.step);

    const tests = builder.addSystemCommand(&.{ "node", "tests/stage.cjs" });
    tests.setCwd(builder.path("."));
    tests.setEnvironmentVariable("ZIG", builder.graph.zig_exe);
    tests.step.dependOn(&release.step);
    builder.step("test", "Build and test the website").dependOn(&tests.step);
}
