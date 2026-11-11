//! Test-only process used to verify cleanup after an engine terminates abnormally.
const std = @import("std");

pub fn main() void {
    std.process.abort();
}
