pub const Operation = enum(u8) {
    ping,
    data,
};
pub const Flags = packed struct {
    urgent: bool = false,
    encrypted: bool = false,
    reserved: u6 = 0,
};
pub const Payload = union(Operation) {
    ping: void,
    data: []const u8,
};
pub const Packet = struct {
    sequence: u32,
    flags: Flags = .{},
    payload: Payload,
};
