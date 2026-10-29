//! Build adapter for native commands, library artifacts, and test runners.
//! These methods declare steps; tools/site.zig performs the native work without
//! importing zast. Wasm and API compilation consume the selected library source.
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
/// Selected library directory, resolved from ZAST_DIR or ../zast using the build allocator.
library_directory: []const u8,
/// Selected library entry point for browser compilation and API documentation.
library_source: Build.LazyPath,

/// Shared engine and generated assets for release and preview; all references are borrowed.
pub const SiteAssets = struct {
    zine: *Step.Compile,
    wasm: *Step.Compile,
    api: Build.LazyPath,
};

/// Parameters for the native coordinator, using its exact command names.
pub const Command = union(enum) {
    /// Remove generated website and example outputs.
    clean,
    /// Generate the catalogue after the caller's snapshot dependency.
    catalog,
    /// Sync the guide from this instance's selected library directory.
    @"sync-examples",
    /// Tracked compiler documentation input; the caller declares the output directory.
    @"prepare-api": Build.LazyPath,
    /// Build and validate the complete site before replacing the previous output.
    build: SiteAssets,
    /// Start the loopback preview with the same assets as a release.
    serve: SiteAssets,
};

// Native command steps.

/// Resolve library paths and declare installation of the native coordinator.
/// Resolution does not access the checkout; selected steps check their required inputs.
pub fn init(builder: *Build) Self {
    const site_directory = builder.root.joinString(builder.allocator, "") catch @panic("OOM");
    const library_directory = builder.pathResolve(&.{
        site_directory,
        builder.graph.environ_map.get("ZAST_DIR") orelse "../zast",
    });
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
        .library_directory = library_directory,
        .library_source = .{
            .cwd_relative = builder.pathJoin(&.{ library_directory, "src/root.zig" }),
        },
    };
}

/// Schedule a command with explicit prerequisites and tracked artifact arguments.
/// dependencies is borrowed only for this call; pass &.{} for no extra prerequisites.
/// The caller declares the prepare-api output directory; its four inputs are tracked here.
/// Other commands modify the source tree, replace dist/, or run the live server.
pub fn addRun(self: Self, command: Command, dependencies: []const *Step) *Step.Run {
    const step = self.builder.addRunArtifact(self.executable);
    step.addArg(@tagName(command));
    step.setCwd(self.builder.path("."));
    step.has_side_effects = true;
    switch (command) {
        .clean, .catalog => {},
        .@"sync-examples" => step.addArg(self.library_directory),
        .@"prepare-api" => |path| {
            step.has_side_effects = false;
            step.addDirectoryArg2(path, .{ .make_absolute = true });
            // Directory arguments track paths, not the files consumed by the command.
            for ([_][]const u8{ "index.html", "main.js", "main.wasm", "sources.tar" }) |name|
                step.addFileInput(path.path(self.builder, name));
        },
        .build, .serve => |assets| {
            step.addArtifactArg2(assets.zine, .{ .make_absolute = true });
            step.addFileArg2(assets.wasm.getEmittedBin(), .{ .make_absolute = true });
            step.addDirectoryArg2(assets.api, .{ .make_absolute = true });
        },
    }
    for (dependencies) |dependency| step.step.dependOn(dependency);
    return step;
}

// Library artifact steps.

/// Declare the Wasm browser generator with its fixed target, exports, and memory limits.
/// The library source is imported by the browser module, not the native coordinator.
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
            const wasm_module = builder.createModule(.{
                .root_source_file = builder.path("wasm/main.zig"),
                .target = wasm_target,
                .optimize = .ReleaseSmall,
            });
            wasm_module.addAnonymousImport("zast", .{
                .root_source_file = self.library_source,
                .target = wasm_target,
                .optimize = .ReleaseSmall,
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
pub fn addApiDocumentation(self: Self) struct {
    documentation_directory: Build.LazyPath,
    prepared_directory: Build.LazyPath,
    step: *Step,
} {
    const builder = self.builder;
    const documentation = builder.addLibrary(.{
        .name = "zast",
        .root_module = builder.createModule(.{
            .root_source_file = self.library_source,
            .target = builder.graph.host,
            .optimize = .Debug,
        }),
    });
    const documentation_directory = documentation.getEmittedDocs();
    const prepare = self.addRun(.{ .@"prepare-api" = documentation_directory }, &.{});
    return .{
        .documentation_directory = documentation_directory,
        .prepared_directory = prepare.addOutputDirectoryArg2("api", .{ .make_absolute = true }),
        .step = &prepare.step,
    };
}

// Test steps.

/// Declare native integration and Node/Wasm runners with their interruption fixture.
/// documentation_directory supplies raw compiler documentation for the fixtures.
/// dependencies is borrowed for this call; include the completed site step for both runners.
pub fn addTests(
    self: Self,
    zine: *Step.Compile,
    wasm: *Step.Compile,
    documentation_directory: Build.LazyPath,
    dependencies: []const *Step,
) struct { content: *Step.Run, browser: *Step.Run } {
    const builder = self.builder;
    const test_paths = builder.addOptions();
    test_paths.addOption([]const u8, "zig_executable", builder.graph.zig_exe);
    test_paths.addOptionPathDirectory("api_directory", documentation_directory);
    test_paths.addOptionPath("zine_executable", zine.getEmittedBin());
    test_paths.addOptionPath("wasm_file", wasm.getEmittedBin());
    const interrupted_engine = builder.addExecutable(.{
        .name = "interrupted-engine",
        .root_module = builder.createModule(.{
            .root_source_file = builder.path("tests/interrupted_engine.zig"),
            .target = builder.graph.host,
            .optimize = .ReleaseSafe,
        }),
    });
    test_paths.addOptionPath(
        "interrupted_engine_executable",
        interrupted_engine.getEmittedBin(),
    );
    const content_module = builder.createModule(.{
        .root_source_file = builder.path("tests/content.zig"),
        .target = builder.graph.host,
        .optimize = .Debug,
    });
    content_module.addImport("site", self.executable.root_module);
    content_module.addOptions("paths", test_paths);
    const content_tests = builder.addRunArtifact(builder.addTest(.{
        .root_module = content_module,
    }));
    const browser_tests = builder.addSystemCommand(&.{ "node", "tests/wasm.cjs" });
    browser_tests.setEnvironmentVariable("ZIG", builder.graph.zig_exe);
    browser_tests.setEnvironmentVariable("ZAST_DIR", self.library_directory);
    for ([_]*Step.Run{ content_tests, browser_tests }) |runner| {
        runner.setCwd(builder.path("."));
        for (dependencies) |dependency| runner.step.dependOn(dependency);
    }
    return .{ .content = content_tests, .browser = browser_tests };
}
