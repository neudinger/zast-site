// Read the same public declaration graph used by Zig's documentation viewer.
// Copy strings and slices before another Wasm call can grow its memory.
export function createApiIndex(api) {
  const decoder = new TextDecoder();
  const string = value => decoder.decode(new Uint8Array(api.memory.buffer,
    Number(value & 0xffffffffn), Number(value >> 32n)));
  const indices = value => Array.from(new Uint32Array(api.memory.buffer,
    Number(value & 0xffffffffn), Number(value >> 32n)));
  const symbols = [];

  function declaration(original, ancestors) {
    const name = string(api.decl_name(original));
    let target = original;
    let category = api.categorize_decl(target, 0);
    const aliases = new Set();
    while (category === 7 && !aliases.has(target)) {
      aliases.add(target);
      target = api.get_aliasee();
      category = api.categorize_decl(target, 0);
    }
    const path = string(api.decl_fqn(target));
    const node = { name, path, category, href: "#" + path, children: [] };
    symbols.push(node);
    if (ancestors.has(target)) return node;
    const parents = new Set(ancestors).add(target);
    const members = category === 0 || category === 1
      ? indices(api.namespace_members(target, false))
      : category === 10 ? indices(api.type_fn_members(target, false)) : [];
    node.children = members.map(member => declaration(member, parents));
    return node;
  }

  // Module zero is the documented library (also the compiler viewer's home).
  // Dependencies remain reachable through signature links, outside the menu.
  const roots = string(api.module_name(0))
    ? [declaration(api.find_module_root(0), new Set())] : [];
  if (roots.length) roots[0].name = string(api.module_name(0));
  return { roots, symbols };
}

// Guide pages load the compiler index only when search is opened. API pages
// reuse the viewer's already-unpacked instance rather than downloading it twice.
export async function loadApiIndex(root, existing) {
  if (existing) return createApiIndex(existing);
  const [wasmResponse, sourcesResponse] = await Promise.all([
    fetch(new URL("docs/api/main.wasm", root)),
    fetch(new URL("docs/api/sources.tar.gz", root)),
  ]);
  if (!wasmResponse.ok || !sourcesResponse.ok) throw new Error("API index unavailable");
  const { instance } = await WebAssembly.instantiate(await wasmResponse.arrayBuffer(), {
    js: { log() {} },
  });
  const sources = new Uint8Array(await new Response(sourcesResponse.body
    .pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  const api = instance.exports;
  const pointer = api.alloc(sources.length);
  new Uint8Array(api.memory.buffer, pointer, sources.length).set(sources);
  api.unpack(pointer, sources.length);
  return createApiIndex(api);
}

export function searchEntries(entries, query, limit = 40) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return entries.slice(0, 8);
  return entries.map((entry, order) => {
    const title = entry.title.toLowerCase();
    const text = (title + " " + (entry.description || "") + " " + (entry.searchText || "")).toLowerCase();
    if (!terms.every(term => text.includes(term))) return null;
    const joined = terms.join(" ");
    const score = title === joined ? 0 : title.startsWith(joined) ? 1
      : title.includes(joined) ? 2 : terms.every(term => title.includes(term)) ? 3 : 4;
    return { entry, order, score };
  }).filter(Boolean).sort((left, right) => left.score - right.score ||
    (left.score < 4 ? left.entry.title.length - right.entry.title.length : 0) || left.order - right.order)
    .slice(0, limit).map(result => result.entry);
}

export const companionExamples = {
  "zast.EnumDeclaration": { id: "enum", title: "Emit an inferred enum" },
  "zast.Declaration": { id: "constant", title: "Emit a constant" },
  "zast.UnionDeclaration": { id: "union", title: "Emit a tagged union" },
  "zast.FunctionDeclaration": { id: "function", title: "Emit a function" },
  "zast.StructDeclaration": { id: "struct", title: "Emit a struct with a method" },
};

export function companionFor(path) {
  // Other methods have different contracts; their compiler documentation stays primary.
  const parent = path.endsWith(".emit") ? path.slice(0, -5) : "";
  return Object.hasOwn(companionExamples, parent) ? companionExamples[parent] : null;
}
