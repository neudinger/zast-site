//! zvm-lock: 0.17.0
//! Build Zine, the browser generator, and API reference with one compiler.
const std = @import("std");
const Build = std.Build;
const Tools = @import("tools/Tools.zig");

comptime {
    const required_version = @import("build.zig.zon").minimum_zig_version;
    if (!std.mem.eql(u8, @import("builtin").zig_version_string, required_version)) {
        @compileError("This site requires Zig " ++ required_version ++
            "; run `zvm run " ++ required_version ++ " build`.");
    }
}

pub fn build(builder: *Build) void {
    // Shared configuration: Zine engine and native site tool with its library paths.
    const zine = builder.dependency("zine", .{
        .target = builder.graph.host,
        .optimize = .ReleaseFast,
        .@"no-git-version" = true,
        .highlight = false,
    }).artifact("zine");

    const tools = Tools.init(builder);

    const purge = purge_blk: {
        const command = builder.addSystemCommand(&.{
            "rm", "-rf", "--", "zig-out", "zig-pkg", ".zig-cache",
        });
        command.setCwd(builder.path("."));
        command.has_side_effects = true;
        break :purge_blk command;
    };

    const clean = tools.addRun(.clean, &.{});
    const sync = tools.addRun(.@"sync-examples", &.{});
    const catalog = tools.addRun(.catalog, &.{&sync.step});

    const wasm = tools.addCompile(.wasm, &.{&sync.step});

    const api = tools.addApiDocumentation();

    // Site build / preview -> native tool + Zine + Wasm + prepared API + catalog.
    // Artifact arguments add compilation dependencies; catalog is linked explicitly.
    const site = site_commands_blk: {
        const assets: Tools.SiteAssets = .{
            .zine = zine,
            .wasm = wasm,
            .api = api.prepared_directory,
        };
        const release = tools.addRun(.{ .build = assets }, &.{&catalog.step});
        const preview = tools.addRun(.{ .serve = assets }, &.{&catalog.step});
        // Default `zig build` -> native tool installation + complete site build.
        builder.getInstallStep().dependOn(&release.step);
        break :site_commands_blk .{ .build = release, .serve = preview };
    };

    // Both test suites require the completed site.
    const tests = tools.addTests(
        zine,
        wasm,
        api.documentation_directory,
        &.{&site.build.step},
    );

    inline for (.{
        // clean -> native tool only; do not regenerate outputs before removing them.
        .{
            .tag = .clean,
            .description = "Remove the generated website, catalogue, and guide snapshots",
            .prerequisites = .{&clean.step},
        },
        // purge -> rm only; remove local Zig outputs without compiling or generating the site.
        .{
            .tag = .purge,
            .description = "Remove local .zig-cache, zig-out, and zig-pkg directories",
            .prerequisites = .{&purge.step},
        },
        // catalog -> sync-examples + native tool -> regenerate the catalogue.
        .{
            .tag = .catalog,
            .description = "Sync guide snapshots, then rebuild the catalogue and copyable examples",
            .prerequisites = .{&catalog.step},
        },
        // sync-examples -> native tool + selected library guide -> refresh snapshots.
        .{
            .tag = .@"sync-examples",
            .description = "Refresh and format the explicit guide snapshots",
            .prerequisites = .{&sync.step},
        },
        // wasm -> browser generator compilation + catalog.
        .{
            .tag = .wasm,
            .description = "Build the browser generator and catalogue",
            .prerequisites = .{ &wasm.step, &catalog.step },
        },
        // api -> compiler documentation + native tool -> prepared API assets.
        .{
            .tag = .api,
            .description = "Build and prepare the library API reference",
            .prerequisites = .{api.step},
        },
        // serve -> all site prerequisites above -> Zine's development server.
        .{
            .tag = .serve,
            .description = "Preview at http://127.0.0.1:1990/",
            .prerequisites = .{&site.serve.step},
        },
        // test-supermd -> site build + native integration tests and interruption fixture.
        .{
            .tag = .@"test-supermd",
            .description = "Compatibility alias: test Zine content, layouts, API, and preview",
            .prerequisites = .{&tests.content.step},
        },
        // test -> site build + native integration tests + Node/Wasm tests.
        .{
            .tag = .@"test",
            .description = "Test Zine content, preview, Wasm, and generated Zig",
            .prerequisites = .{ &tests.content.step, &tests.browser.step },
        },
    }) |command| {
        const command_step = builder.step(@tagName(command.tag), command.description);
        inline for (command.prerequisites) |prerequisite| command_step.dependOn(prerequisite);
    }
}
