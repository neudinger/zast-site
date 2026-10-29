//! Build the browser catalogue from guide snapshots and site fixtures. The build
//! graph syncs the selected library guide before catalogue generation or Wasm compilation.
const std = @import("std");
const files = @import("files.zig");

pub const Entry = struct {
    id: []const u8,
    title: []const u8,
    name: ?[]const u8 = null,
    number: ?usize = null,
    group: []const u8,
    description: ?[]const u8 = null,
    body: ?[]const u8 = null,
    expected: ?[]const u8 = null,
    input: std.json.Value,
};

fn json(allocator: std.mem.Allocator, value: anytype) ![]u8 {
    return std.json.Stringify.valueAlloc(allocator, value, .{ .whitespace = .indent_2, .emit_null_optional_fields = false });
}

fn parse(allocator: std.mem.Allocator, text: []const u8) !std.json.Value {
    return std.json.parseFromSliceLeaky(std.json.Value, allocator, text, .{});
}

fn jsonValue(allocator: std.mem.Allocator, value: anytype) !std.json.Value {
    return parse(allocator, try json(allocator, value));
}

const variations = [_]struct {
    id: []const u8,
    title: []const u8,
    input: struct {
        name: []const u8,
        backing_type: ?[]const u8 = null,
        non_exhaustive: ?bool = null,
        fields: []const struct { name: []const u8, value: ?i64 = null } = &.{},
    },
}{
    .{ .id = "basic", .title = "Simple numeric enum", .input = .{
        .name = "Status",
        .backing_type = "u8",
        .fields = &.{ .{ .name = "unknown", .value = 0 }, .{ .name = "ok", .value = 1 } },
    } },
    .{ .id = "status", .title = "Explicit enum and catch-all", .input = .{
        .name = "Status",
        .backing_type = "u8",
        .non_exhaustive = true,
        .fields = &.{ .{ .name = "unknown", .value = 0 }, .{ .name = "ok", .value = 1 }, .{ .name = "warning", .value = 2 } },
    } },
    .{ .id = "inferred", .title = "Directions enum", .input = .{
        .name = "Direction",
        .fields = &.{ .{ .name = "north" }, .{ .name = "east" }, .{ .name = "south" }, .{ .name = "west" } },
    } },
    .{ .id = "signed", .title = "Signed enum values", .input = .{
        .name = "Signal",
        .backing_type = "i16",
        .fields = &.{ .{ .name = "negative", .value = -1 }, .{ .name = "quiet", .value = 0 }, .{ .name = "positive", .value = 1 } },
    } },
    .{ .id = "offset", .title = "Non-exhaustive offset", .input = .{ .name = "Offset", .backing_type = "u32", .non_exhaustive = true } },
    .{ .id = "empty", .title = "Empty enum", .input = .{ .name = "Empty" } },
};

/// All returned descriptions belong to the caller's arena.
pub fn load(allocator: std.mem.Allocator, io: std.Io) ![]const Entry {
    var entries: std.ArrayList(Entry) = .empty;
    try entries.appendSlice(allocator, try std.json.parseFromSliceLeaky([]const Entry, allocator, try files.read(allocator, io, "wasm/guide-catalog.json"), .{}));
    try entries.appendSlice(allocator, &.{ .{
        .id = "json-schema",
        .title = "Schema-driven struct",
        .number = 14,
        .group = "README examples",
        .description = "Edit UInt fields and defaults. This lesson adds answerFunc(), returning 84.",
        .input = try jsonValue(allocator, .{
            .example = "json-schema",
            .schema = .{
                .enums = &[_]std.json.Value{},
                .objects = .{.{
                    .name = "Reading",
                    .fields = .{.{ .name = "answer", .type = .{ .base_type = "UInt" }, .default_integer = 65 }},
                }},
            },
        }),
        .expected = "pub const Reading = struct {\n    answer: u32 = 65,\n    pub fn answerFunc() u32 {\n        return 84;\n    }\n};\n",
    }, .{
        .id = "flatbuf-json",
        .title = "FlatBuffers JSON",
        .number = 15,
        .group = "README examples",
        .description = "A small schema lesson: UByte enums and UInt fields become ordinary Zig declarations.",
        .input = try parse(allocator, try std.fmt.allocPrint(allocator, "{{\"example\":\"flatbuf-json\",\"schema\":{s}}}", .{try files.read(allocator, io, "wasm/fixtures/reading.json")})),
        .expected = try files.read(allocator, io, "wasm/fixtures/reading.expected.zig"),
    } });
    const showcases = [_]struct { id: []const u8, title: []const u8, name: []const u8, description: []const u8 }{
        .{ .id = "protocol", .title = "Protocol model", .name = "Packet", .description = "Compose a named enum, packed flags, a tagged union, and a packet struct. Native Zig layout is not a wire serializer." },
        .{ .id = "configuration", .title = "Application configuration", .name = "Configuration", .description = "Combine defaults, optional strings, an anonymous enum, and a receiver method." },
        .{ .id = "generic-storage", .title = "Generic storage factory", .name = "Storage", .description = "Generate a comptime type factory returning a struct with a borrowed slice and method." },
    };
    for (showcases) |showcase| {
        const source = try files.read(allocator, io, try std.fmt.allocPrint(allocator, "wasm/showcase/{s}.zig", .{showcase.id}));
        const start = (std.mem.indexOf(u8, source, "!void {\n") orelse return error.MissingShowcaseBody) + 8;
        const end = std.mem.lastIndexOfScalar(u8, source, '}') orelse return error.MissingShowcaseBody;
        var output: std.Io.Writer.Allocating = .init(allocator);
        var lines = std.mem.splitScalar(u8, std.mem.trimEnd(u8, source[start..end], " \n\r\t"), '\n');
        while (lines.next()) |line| try output.writer.print("{s}\n", .{if (std.mem.startsWith(u8, line, "    ")) line[4..] else line});
        try entries.append(allocator, .{
            .id = showcase.id,
            .title = showcase.title,
            .name = showcase.name,
            .description = showcase.description,
            .group = "Composed showcases",
            .body = try output.toOwnedSlice(),
            .input = try jsonValue(allocator, .{ .example = showcase.id, .name = showcase.name }),
            .expected = try files.read(allocator, io, try std.fmt.allocPrint(allocator, "wasm/showcase/{s}.expected.zig", .{showcase.id})),
        });
    }
    for (variations) |variation| try entries.append(allocator, .{ .id = variation.id, .title = variation.title, .group = "Enum variations", .input = try jsonValue(allocator, variation.input) });
    return entries.toOwnedSlice(allocator);
}

pub fn build(allocator: std.mem.Allocator, io: std.Io) !void {
    const entries = try load(allocator, io);
    const javascript = try std.fmt.allocPrint(allocator, "// Generated by zig build catalog.\nexport const catalog = {s};\n", .{try json(allocator, entries)});
    var guide: std.Io.Writer.Allocating = .init(allocator);
    try guide.writer.writeAll(@embedFile("catalog-intro.smd"));
    for (entries) |entry| {
        try guide.writer.print("[]($section.id('{s}'))\n\n## ", .{entry.id});
        if (entry.number) |number| try guide.writer.print("{d}. ", .{number});
        try guide.writer.print("{s}\n\n", .{entry.title});
        if (entry.description) |description| try guide.writer.print("{s}\n\n", .{description});
        // The pinned Zine resolver treats query strings as part of a page name.
        // Use page-relative URLs so the link also works under a deployment prefix.
        try guide.writer.print("```=html\n<p><a href=\"../../examples/?example={s}\">Try this example</a></p>\n```\n\n", .{entry.id});
        if (entry.body) |body| {
            try guide.writer.print("**zast interface**\n\n```zig\n{s}```\n\n", .{try files.replace(allocator, body, "output_name", try std.json.Stringify.valueAlloc(allocator, entry.name.?, .{}))});
        } else try guide.writer.print("**Editable input**\n\n```json\n{s}\n```\n\n", .{try json(allocator, entry.input)});
        if (entry.expected) |expected| try guide.writer.print("**Generated Zig**\n\n```zig\n{s}```\n\n", .{expected});
    }
    try files.write(io, "assets/catalog.js", javascript);
    try files.write(io, "content/docs/examples.smd", guide.written());
}

/// Refresh both snapshots only after every required section and generated Zig parses.
pub fn sync(allocator: std.mem.Allocator, io: std.Io, library: []const u8) !void {
    const source = try files.read(allocator, io, try std.fs.path.join(allocator, &.{ library, "docs/examples.md" }));
    const guide = try compileGuide(allocator, source);
    try files.write(io, "wasm/GuideExamples.zig", guide.zig);
    try files.write(io, "wasm/guide-catalog.json", guide.snapshot);
}

pub const Guide = struct { zig: []const u8, snapshot: []const u8 };

/// Compile the curated guide into formatted Zig and JSON, using a caller arena.
/// Missing sections, snippets, or root emissions fail before either output is written.
pub fn compileGuide(allocator: std.mem.Allocator, source: []const u8) !Guide {
    const definitions = [_][3][]const u8{
        .{ "constant", "A constant", "answer" },                      .{ "types", "Compose types", "OptionalText" },
        .{ "enum", "An inferred enum", "Status" },                    .{ "union", "A tagged union", "Payload" },
        .{ "function", "A function", "identity" },                    .{ "struct", "A struct with a method", "Reading" },
        .{ "nested", "Embed an anonymous type", "Response" },         .{ "builtin", "A builtin call", "scalar_size" },
        .{ "initializer", "A value initializer", "options" },         .{ "comments", "Comments and documentation", "answer" },
        .{ "callback", "A function pointer type", "Callback" },       .{ "blocks", "Nested blocks", "noop" },
        .{ "comptime", "Comptime and error propagation", "forward" },
    };
    var entries: std.ArrayList(Entry) = .empty;
    var generated: std.Io.Writer.Allocating = .init(allocator);
    const writer = &generated.writer;
    try writer.writeAll("// Generated by zig build sync-examples from zast/docs/examples.md.\nconst std = @import(\"std\");\nconst zast = @import(\"zast\");\n\npub const Kind = enum { ");
    for (definitions, 0..) |definition, index| try writer.print("{s}{f}", .{ if (index == 0) "" else ", ", std.zig.fmtId(definition[0]) });
    try writer.writeAll(" };\n\npub fn emit(kind: Kind, allocator: std.mem.Allocator, context: *zast.AstContext, name: ?[]const u8) !void {\nswitch (kind) {\n");
    for (definitions, 1..) |definition, number| {
        const marker = try std.fmt.allocPrint(allocator, "\n## {d}. ", .{number});
        const section_start = (std.mem.indexOf(u8, source, marker) orelse return error.MissingGuideSection) + marker.len;
        const section_end = if (std.mem.indexOf(u8, source[section_start..], "\n## ")) |offset| section_start + offset else source.len;
        var snippets = std.mem.splitSequence(u8, source[section_start..section_end], "```zig\n");
        _ = snippets.next();
        var pair: [2][]const u8 = undefined;
        for (&pair) |*snippet| {
            const remaining = snippets.next() orelse return error.MissingGuideSnippet;
            snippet.* = remaining[0 .. std.mem.indexOf(u8, remaining, "```") orelse return error.MissingGuideSnippet];
        }
        const root = try std.fmt.allocPrint(allocator, "context, \"{s}\",", .{definition[2]});
        if (std.mem.count(u8, pair[0], root) != 1) return error.MissingRootEmission;
        const body = try files.replace(allocator, pair[0], root, "context, output_name,");
        try entries.append(allocator, .{
            .id = definition[0],
            .title = definition[1],
            .name = definition[2],
            .number = number,
            .group = "README examples",
            .body = body,
            .expected = pair[1],
            .input = try jsonValue(allocator, .{ .example = definition[0], .name = definition[2] }),
        });
        try writer.print(".{f} => {{\nconst output_name = name orelse \"{f}\";\n{s}\n}},\n", .{ std.zig.fmtId(definition[0]), std.zig.fmtString(definition[2]), body });
    }
    try writer.writeAll("}\n}\n");
    const terminated = try allocator.dupeSentinel(u8, generated.written(), 0);
    var tree = try std.zig.Ast.parse(allocator, terminated, .{});
    defer tree.deinit(allocator);
    if (tree.errors.len != 0) return error.InvalidGeneratedZig;
    return .{
        .zig = try tree.renderAlloc(allocator),
        .snapshot = try std.fmt.allocPrint(allocator, "{s}\n", .{try json(allocator, entries.items)}),
    };
}
