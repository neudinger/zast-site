const test = require("node:test");

process.env.ZAST_ROOT = process.argv[2];
require("./stage-1.cjs");
require("./stage-2.cjs");
test("browser generator emits Zig and inspects its AST", require("./wasm.cjs").checkWasm);
require("./stage-4.cjs");
require("./stage-5.cjs");
require("./stage-6.cjs");
