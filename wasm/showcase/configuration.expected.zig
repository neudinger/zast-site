pub const Configuration = struct {
    host: []const u8 = "localhost",
    port: u16 = 8080,
    log_level: enum {
        quiet,
        info,
        debug,
    } = .info,
    token: ?[]const u8 = null,
    pub fn hostname(self: *const @This()) []const u8 {
        return self.host;
    }
};
