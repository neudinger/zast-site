const assert = require("node:assert/strict");

async function checkTree() {
  const { AstTree, layoutTree, tokenLines, placeTreeLabels } = await import("../assets/tree.js");
  const tree = (nodes, tokens = []) => layoutTree({ nodes: nodes.map((node, index) => ({ index, main_token: index, tag: "identifier", ...node })), tokens });
  const constant = tree([
    { tag: "root", children: [1] },
    { tag: "simple_var_decl", children: [2, 3] },
    { children: [] }, { tag: "number_literal", children: [] },
  ], [{ spelling: "pub" }, { spelling: "const" }, { spelling: "answer" }, { spelling: "42" }]);
  assert.deepEqual(constant.branches.map(edge => [edge.from, edge.to]), [[0, 1], [1, 2], [1, 3]]);
  assert.deepEqual(constant.leaves.map(node => node.index), [2, 3]);
  assert.equal(constant.labels[0].node.label, "answer");
  assert.equal(constant.labels[0].value, "42");
  assert.equal(constant.depth, 2);
  assert(constant.nodes[2].x < constant.nodes[3].x);
  const signed = tree([
    { tag: "root", children: [1], main_token: 0 },
    { tag: "container_field_init", children: [2], main_token: 0 },
    { tag: "negation", children: [3], main_token: 2 },
    { tag: "number_literal", children: [], main_token: 3 },
  ], [{ tag: "identifier", spelling: "negative" }, { tag: "equal", spelling: "=" }, { tag: "minus", spelling: "-" }, { tag: "number_literal", spelling: "1" }]);
  assert.equal(signed.labels[0].value, "-1", "value labels preserve numeric negation");
  const callback = tree([
    { tag: "root", children: [1], main_token: 0 },
    { tag: "simple_var_decl", children: [2], main_token: 0 },
    { tag: "fn_proto_simple", children: [3], main_token: 3 },
    { tag: "identifier", children: [], main_token: 6 },
  ], [{ tag: "keyword_const", spelling: "const" }, { tag: "identifier", spelling: "Callback" }, { tag: "equal", spelling: "=" }, { tag: "keyword_fn", spelling: "fn" }, { tag: "l_paren", spelling: "(" }, { tag: "r_paren", spelling: ")" }, { tag: "identifier", spelling: "u32" }]);
  assert.equal(callback.nodes.find(node => node.index === 2).kind, "type");
  assert.equal(callback.nodes.find(node => node.index === 2).label, "fn");
  assert.deepEqual(callback.labels.map(label => label.node.label), ["Callback"]);

  const broad = tree([{ tag: "root", children: [1] }, { tag: "container_decl", children: Array.from({ length: 32 }, (_, i) => i + 2) }, ...Array.from({ length: 32 }, () => ({ tag: "container_field_init", children: [] }))]);
  const deep = tree(Array.from({ length: 15 }, (_, index) => ({ children: index < 14 ? [index + 1] : [] })));
  assert(broad.nodes.at(-1).x - broad.nodes[2].x > constant.nodes[3].x - constant.nodes[2].x, "larger branching produces a wider canopy");
  assert(Math.min(...deep.nodes.map(node => node.y)) < Math.min(...constant.nodes.map(node => node.y)), "nesting increases tree height");
  for (const model of [constant, broad, deep]) for (const node of model.nodes) {
    assert(Number.isFinite(node.x) && Number.isFinite(node.y));
    assert(node.x >= 0 && node.x <= 1 && node.y >= 0 && node.y <= 1);
  }
  const shared = tree([{ children: [1, 2] }, { children: [3] }, { children: [3] }, { children: [] }]);
  assert.equal(shared.nodes.length, 4, "shared nodes are represented only once");
  assert.equal(shared.branches.length, 4, "both semantic references remain represented");
  const malformed = tree([{ children: [1, 1, 99] }, { children: [0, 2] }, { children: [1] }]);
  assert.equal(malformed.nodes.length, 3);
  assert.equal(malformed.branches.length, 2, "cycles, duplicate edges and invalid references are ignored");
  assert.deepEqual(layoutTree(null).nodes, []);
  assert.deepEqual(layoutTree({ nodes: [] }).branches, []);
  assert.deepEqual(tree([{ children: [1] }, { children: [] }]), tree([{ children: [1] }, { children: [] }]), "layout is deterministic");
  const spellings = ["/// name", "const", "name", "=", '"name"', ";", "const", "other", "=", "name", ";"];
  const inspection = { tokens: spellings.map((spelling, index) => ({ index, spelling })) };
  const source = '/// name\nconst name = "name";\nconst other = name;\n';
  assert.deepEqual(tokenLines(inspection, source), [[0, 0], ...Array.from({ length: 5 }, () => [1, 1]), ...Array.from({ length: 5 }, () => [2, 2])]);
  assert.equal(tokenLines(inspection, source.replace("other", "different")), null);
  assert.deepEqual(tokenLines({ tokens: [{ index: 0, spelling: "/// first\n/// second" }] }, "/// first\n/// second\n"), [[0, 1]]);
  assert.deepEqual(tokenLines({ tokens: [{ index: 0, tag: "container_doc_comment", spelling: "//! documentation. " }, { index: 1, tag: "doc_comment", spelling: "/// declaration. " }] }, "//! documentation.\n/// declaration.\n"), [[0, 0], [1, 1]]);
  for (const width of [284, 339, 700]) for (const count of [3, 13, 32]) {
    const items = Array.from({length:count}, (_, index) => ({node:{index,x:.5,y:.2,depth:3},width:Math.min(140,width-16),height:44}));
    const packed = placeTreeLabels(items, width, 350);
    assert.equal(packed.labels.length, count, "every registered node keeps its control");
    for (const [index, label] of packed.labels.entries()) {
      assert(label.x >= 0 && label.x + label.width <= width);
      assert(label.y >= 0 && label.y + label.height <= packed.height);
      assert(!packed.labels.slice(0,index).some(previous => label.x < previous.x + previous.width && label.x + label.width > previous.x && label.y < previous.y + previous.height && label.y + label.height > previous.y), "controls never overlap");
    }
  }
  const hitTest = { canvas:{getBoundingClientRect:()=>({left:10,top:20})}, width:500, height:400,
    view:{leaves:[{index:1,x:.4,y:.5},{index:2,x:.45,y:.5}]} };
  assert.equal(AstTree.prototype.leafAt.call(hitTest,{clientX:219,clientY:198}).index,2,"overlapping hit areas select the nearest registered leaf");
  assert.equal(AstTree.prototype.leafAt.call(hitTest,{clientX:0,clientY:0}),null,"empty canvas does not select a leaf");
  const previousWindow = globalThis.window;
  try {
    globalThis.window = {devicePixelRatio:1};
    let extra = 90;
    const stage = {style:{minHeight:"580px",setProperty:(_name,value)=>{extra=parseInt(value);}},getBoundingClientRect:()=>({width:726,height:Math.max(430+extra,parseInt(stage.style.minHeight)||0)})};
    const resized = {stage,width:339,controls:Array(11),canvas:{},context:null,sizeStage:AstTree.prototype.sizeStage,placeLabels(){},draw(){}};
    AstTree.prototype.resize.call(resized);
    assert.equal(resized.height,430,"desktop resizing removes mobile-only vertical expansion");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

module.exports = { checkTree };
if (require.main === module) checkTree().catch(error => { console.error(error); process.exitCode = 1; });
