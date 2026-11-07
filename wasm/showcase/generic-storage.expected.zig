pub fn Storage(comptime Item: type) type {
    return struct {
        items: []const Item,
        pub fn view(self: *const @This()) []const Item {
            return self.items;
        }
    };
}
