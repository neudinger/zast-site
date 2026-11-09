//! Build adapter for native commands and library artifacts.
//! These methods declare steps. Wasm and API compilation consume Zast's exported module.
//! The graph owns its references and library paths; no deinit is needed. Named commands and
//! dependency lists stay in build.zig; addRun() schedules rather than executes work.
const std = @import("std");
const Build = std.Build;
const Step = Build.Step;
const Self = @This();

/// Root builder used for paths, artifacts, and command steps.
builder: *Build,
/// Native executable shared by every command.
executable: *Step.Compile,

/// Parameters for the native coordinator, using its exact command names.
pub const Command = union(enum) {
    /// Remove generated website and example outputs.
    clean,
    /// Generate the catalogue after the caller's snapshot dependency.
    catalog,
    /// Sync the guide from the declared library package directory.
    @"sync-examples": Build.LazyPath,
    /// Tracked compiler documentation input; the caller declares the output directory.
    @"prepare-api": Build.LazyPath,
};

// Native command steps.

/// Declare installation of the native coordinator.
pub fn init(builder: *Build) Self {
    const executable = builder.addExecutable(.{
        .name = "zast-site",
        .root_module = builder.createModule(.{
            .root_source_file = builder.path("tools/site.zig"),
            .target = builder.graph.host,
            .optimize = .ReleaseSafe,
        }),
    });
    builder.installArtifact(executable);
    return .{
        .builder = builder,
        .executable = executable,
    };
}

/// Schedule a command with explicit prerequisites and tracked artifact arguments.
/// dependencies is borrowed only for this call; pass &.{} for no extra prerequisites.
/// The caller declares the prepare-api output directory; its four inputs are tracked here.
/// Other commands modify generated files in the project directory.
pub fn addRun(self: Self, command: Command, dependencies: []const *Step) *Step.Run {
    const step = self.builder.addRunArtifact(self.executable);
    step.addArg(@tagName(command));
    step.setCwd(self.builder.path("."));
    step.has_side_effects = true;
    switch (command) {
        .clean, .catalog => {},
        .@"sync-examples" => |directory| step.addDirectoryArg2(directory, .{
            .make_absolute = true,
        }),
        .@"prepare-api" => |path| {
            step.has_side_effects = false;
            step.addDirectoryArg2(path, .{ .make_absolute = true });
            // Directory arguments track paths, not the files consumed by the command.
            for ([_][]const u8{ "index.html", "main.js", "main.wasm", "sources.tar" }) |name|
                step.addFileInput(path.path(self.builder, name));
        },
    }
    for (dependencies) |dependency| step.step.dependOn(dependency);
    return step;
}

// Library artifact steps.

/// Declare the Wasm browser generator with its fixed target, exports, and memory limits.
pub fn addCompile(
    self: Self,
    compilation_target: enum { wasm },
    dependencies: []const *Step,
) *Step.Compile {
    const builder = self.builder;
    const artifact = switch (compilation_target) {
        .wasm => wasm_blk: {
            const wasm_target = builder.resolveTargetQuery(.{
                .cpu_arch = .wasm32,
                .os_tag = .freestanding,
            });
            const zast = builder.dependency("zast", .{
                .target = wasm_target,
                .optimize = .ReleaseSmall,
            });
            const wasm_module = builder.createModule(.{
                .root_source_file = builder.path("wasm/main.zig"),
                .target = wasm_target,
                .optimize = .ReleaseSmall,
                .imports = &.{.{ .name = "zast", .module = zast.module("zast") }},
            });
            wasm_module.export_symbol_names = &.{
                "inputPointer",
                "inputCapacity",
                "generate",
                "outputPointer",
                "outputLength",
                "inspectPointer",
                "inspectLength",
            };
            const executable = builder.addExecutable(.{
                .name = "playground",
                .root_module = wasm_module,
            });
            executable.entry = .disabled;
            executable.export_memory = true;
            executable.stack_size = 1024 * 1024;
            executable.max_memory = 16 * 1024 * 1024;
            break :wasm_blk executable;
        },
    };
    for (dependencies) |dependency| artifact.step.dependOn(dependency);
    return artifact;
}

/// Declare compiler documentation and prepare its viewer assets in the build cache.
/// Return both directories and the preparation step for the caller's assets, tests, and commands.
pub fn addApiDocumentation(self: Self, library: *Build.Module) struct {
    documentation_directory: Build.LazyPath,
    prepared_directory: Build.LazyPath,
    step: *Step,
} {
    const builder = self.builder;
    const documentation = builder.addLibrary(.{
        .name = "zast",
        .root_module = library,
    });
    const documentation_directory = documentation.getEmittedDocs();
    const prepare = self.addRun(.{ .@"prepare-api" = documentation_directory }, &.{});
    return .{
        .documentation_directory = documentation_directory,
        .prepared_directory = prepare.addOutputDirectoryArg2("api", .{ .make_absolute = true }),
        .step = &prepare.step,
    };
}
