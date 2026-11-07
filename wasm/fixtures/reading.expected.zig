pub const Status = enum(u8) {
    Unknown = 0,
    Ok = 1,
    Warning = 2,
    _,
};
pub const Reading = struct {
    answer: u32 = 65,
};
