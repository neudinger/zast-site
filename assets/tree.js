// The botanical projection uses the inspected AST's edges, never source heuristics.
const colors = { declaration: "#a1f0d0", type: "#d29aef", value: "#f4ba93", identifier: "#93d9d8" };
const noise = index => Math.sin(index * 127.1 + 31.7) * .5 + .5;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function description(node, tokens) {
  const token = tokens[node.main_token];
  const spelling = token?.spelling || node.tag.replaceAll("_", " ");
  const anonymousFunction = /fn_proto/.test(node.tag) && tokens[node.main_token + 1]?.tag !== "identifier";
  const negativeNumber = node.tag === "negation" && tokens[node.main_token + 1]?.tag === "number_literal";
  const declaration = /var_decl|fn_decl|fn_proto|container_field/.test(node.tag) && !anonymousFunction;
  const name = node.tag === "root" ? "File" : node.tag === "optional_type" ? "optional"
    : /^block/.test(node.tag) ? "body" : node.tag === "field_access" ? "." + (tokens[node.main_token + 1]?.spelling || "")
    : /^ptr_type/.test(node.tag) ? spelling === "[" ? "slice" : "pointer"
    : negativeNumber ? "-" + tokens[node.main_token + 1].spelling : /var_decl|fn_decl|fn_proto/.test(node.tag) && !anonymousFunction
    ? tokens[node.main_token + 1]?.spelling || spelling : node.tag === "enum_literal"
      ? "." + (tokens[node.main_token + (spelling === "." ? 1 : 0)]?.spelling || "") : spelling;
  const kind = declaration ? "declaration" : negativeNumber || /literal/.test(node.tag) || /^(true|false|null|undefined)$/.test(spelling)
    ? "value" : anonymousFunction || /_type|container_decl/.test(node.tag) || /^(u\d+|i\d+|f\d+|void|bool|usize|isize|anyerror|type)$/.test(spelling)
      ? "type" : "identifier";
  return { label: name, kind, declaration };
}

/** Match inspected token spellings in order to the formatted output. A mismatch
 * disables source linking instead of highlighting an unrelated source line. */
export function tokenLines(inspection, source) {
  const lines = [];
  let cursor = 0, line = 0;
  for (const token of inspection.tokens) {
    if (token.tag === "eof" || !token.spelling) continue;
    // The Zig renderer removes trailing whitespace from documentation comments.
    const spelling = /doc_comment$/.test(token.tag) ? token.spelling.trimEnd() : token.spelling;
    const start = source.indexOf(spelling, cursor);
    if (start < 0) return null;
    for (let index = cursor; index < start; index++) if (source[index] === "\n") line++;
    const first = line;
    cursor = start + spelling.length;
    for (let index = start; index < cursor; index++) if (source[index] === "\n") line++;
    lines[token.index] = [first, line];
  }
  return lines;
}

/** A bounded, deterministic projection. Shared child nodes keep one position;
 * every non-cyclic edge remains visible. Invalid references are ignored so a
 * failed/older inspector cannot create a runaway traversal or synthetic nodes. */
export function layoutTree(inspection) {
  const source = inspection?.nodes || [];
  const tokens = inspection?.tokens || [];
  const byIndex = new Map(source.map(node => [node.index, node]));
  if (!byIndex.has(0)) return { nodes: [], branches: [], leaves: [], labels: [], depth: 0 };
  const nodes = [], branches = [], visited = new Map(), active = new Set();
  const stack = [{ index: 0, depth: 0, parent: null, exit: false }];
  while (stack.length) {
    const item = stack.pop();
    if (item.exit) { active.delete(item.index); continue; }
    if (active.has(item.index)) continue;
    const ast = byIndex.get(item.index);
    if (!ast) continue;
    if (item.parent) branches.push({ from: item.parent.index, to: item.index });
    if (visited.has(item.index)) continue;
    const node = { ...ast, ...description(ast, tokens), depth: item.depth, parent: item.parent?.index ?? null, children: [], weight: 1, x: .5, y: .91 };
    visited.set(node.index, node);
    nodes.push(node);
    if (item.parent) item.parent.children.push(node.index);
    active.add(node.index);
    stack.push({ ...item, exit: true });
    for (const index of [...new Set(ast.children || [])].reverse()) {
      if (index !== 0 && byIndex.has(index)) stack.push({ index, depth: item.depth + 1, parent: node, exit: false });
    }
  }
  const depth = Math.max(...nodes.map(node => node.depth), 1);
  for (const node of [...nodes].reverse()) {
    node.weight = node.children.reduce((sum, index) => sum + visited.get(index).weight, 0) || 1;
  }
  const breadth = clamp(.14 + Math.log2(nodes.length + 1) * .125, .28, .82);
  const height = clamp(.20 + depth * .075 + Math.log2(nodes.length + 1) * .028, .30, .77);
  const placement = [{ node: nodes[0], start: -1, end: 1 }];
  while (placement.length) {
    const { node, start, end } = placement.pop();
    const progress = node.depth / depth;
    node.x = .5 + (start + end) * breadth / 4;
    node.y = .14 + Math.pow(Math.abs(node.x - .5) / (breadth / 2), 1.5) * .25;
    if (node.depth > 0) {
      node.x += (noise(node.index) - .5) * .025 * progress;
      node.y += (noise(node.index + 70) - .5) * .055;
    }
    let cursor = start;
    for (const index of node.children) {
      const child = visited.get(index);
      const span = (end - start) * child.weight / node.weight;
      placement.push({ node: child, start: cursor, end: cursor + span });
      cursor += span;
    }
  }
  // Short unary steps sit along a limb. Forks have breathing room, while the
  // root/declaration stem remains a continuous trunk instead of a level grid.
  for (const node of [...nodes].reverse()) {
    if (!node.children.length) continue;
    const gap = node.depth < 2 && node.children.length === 1 ? .10 : node.children.length === 1 ? .028 : .075;
    node.y = Math.max(...node.children.map(index => visited.get(index).y)) + gap;
  }
  const top = Math.min(...nodes.map(node => node.y));
  const rootY = nodes[0].y;
  const extent = rootY - top || 1;
  for (const node of nodes) {
    node.y = .91 - (rootY - node.y) / extent * height;
    node.thickness = node.index === 0 ? Math.min(60, Math.pow(node.weight, .65) * 11)
      : node.children.length ? Math.min(48, Math.pow(node.weight, .65) * 8) : .8;
  }
  for (const node of nodes) {
    const parent = visited.get(node.parent) || node;
    const next = node.children.length ? {
      x: node.children.reduce((sum, index) => sum + visited.get(index).x, 0) / node.children.length,
      y: node.children.reduce((sum, index) => sum + visited.get(index).y, 0) / node.children.length,
    } : node;
    node.direction = { x: next.x - parent.x, y: next.y - parent.y };
  }
  for (const branch of branches) {
    const parent = visited.get(branch.from), child = visited.get(branch.to);
    branch.width = parent.children.length === 1 ? parent.thickness : Math.max(child.thickness * 1.18, 4);
    branch.start = parent;
    branch.end = child;
  }
  const leaves = nodes.filter(node => node.index !== 0 && !(byIndex.get(node.index).children || []).some(index => byIndex.has(index) && index !== node.index));
  const declarations = nodes.filter(node => node.declaration && node.index !== 0);
  const candidates = declarations.filter((node, index) => !/var_decl/.test(node.tag) && !declarations.slice(0, index).some(previous => previous.main_token === node.main_token));
  const topLevel = declarations.filter(node => node.depth === 1);
  const firstDepth = Math.min(...candidates.map(node => node.depth));
  const prominent = topLevel.length > 1 ? topLevel : candidates.length
    ? candidates.filter(node => node.depth === firstDepth) : declarations;
  const labels = prominent.slice(0, 6).map(node => {
    const pending = [...node.children];
    let value = null;
    while (pending.length) {
      const child = visited.get(pending.shift());
      if (child.kind === "value") { value = child.label; break; }
      pending.push(...child.children);
    }
    return { node, value };
  });
  if (topLevel.length === 1 && !labels.some(label => label.node === topLevel[0])) labels.push({ node: topLevel[0], value: null });
  if (!labels.length) labels.push(...leaves.slice(0, 4).map(node => ({ node, value: null })));
  return { nodes, branches, leaves, labels, depth };
}

/** Node identity is scoped to the current generated AST, including equal-valued
 * leaves with different owners. Parent paths never use labels as keys. */
export function nodePath(model, index) {
  const registry = new Map(model.nodes.map(node => [node.index, node]));
  const path = [], seen = new Set();
  let node = registry.get(index);
  while (node && !seen.has(node.index)) {
    seen.add(node.index);
    path.unshift(node);
    node = registry.get(node.parent);
  }
  return path;
}

export function initialBranches(model) {
  const expanded = new Set(model.nodes.filter(node => node.depth < 3).map(node => node.index));
  const nested = model.nodes.find(node => /container_decl/.test(node.tag) && node.depth > 2);
  let selected;
  if (nested) {
    const members = model.leaves.filter(node => nodePath(model, node.index).some(parent => parent.index === nested.index));
    const owner = nodePath(model, nested.index).at(-2);
    const defaultValue = model.nodes.find(node => owner?.children.includes(node.index) && node.tag === "enum_literal");
    selected = members.find(node => node.label === defaultValue?.label.replace(/^\./, "")) || members[0] || nested;
    // Open one informative subtree. Other fields remain compact until expanded.
    for (const member of members) for (const node of nodePath(model, member.index)) expanded.add(node.index);
  } else selected = model.leaves.find(node => node.kind === "value") || model.leaves[0] || model.nodes[0];
  if (selected) for (const node of nodePath(model, selected.index).slice(0, -1)) expanded.add(node.index);
  return { expanded, selected: selected?.index ?? null };
}

/** A collapsed branch remains a branch, never an invented terminal leaf. */
export function branchView(inspection, expanded, model = layoutTree(inspection)) {
  const original = new Map(inspection.nodes.map(node => [node.index, node]));
  const full = new Map(model.nodes.map(node => [node.index, node]));
  const view = layoutTree({ ...inspection, nodes: inspection.nodes.map(node => ({
    ...node, children: expanded.has(node.index) ? [...node.children].sort((left, right) =>
      Number(expanded.has(left) && original.get(left).children.length > 1) -
      Number(expanded.has(right) && original.get(right).children.length > 1)) : [],
  })) });
  // Expanded subtrees occupy the outer canopy. Collapsing hides descendants,
  // while branch thickness continues to represent their actual AST weight.
  for (const node of view.nodes) {
    node.collapsed = original.get(node.index).children.length > 0 && !expanded.has(node.index);
    node.thickness = full.get(node.index).thickness * (node.collapsed ? .65 : 1);
  }
  for (const branch of view.branches) branch.width = branch.start.children.length === 1
    ? branch.start.thickness : Math.max(branch.end.thickness * 1.18, 4);
  view.leaves = view.leaves.filter(node => original.get(node.index).children.length === 0);
  return view;
}

/** Keep every registered control reachable. Dense or narrow trees grow
 * vertically rather than silently omitting a leaf or overlapping its label. */
export function placeTreeLabels(items, width, initialHeight) {
  let height = initialHeight;
  const step = Math.max(48, ...items.map(item => item.height + 16));
  for (let attempt = 0; attempt <= items.length; attempt++, height += step) {
    const labels = [];
    for (const item of items) {
      const side = item.node.x < .5 ? -1 : 1;
      const desiredX = clamp(item.node.x * width + (item.node.depth === 1 ? -item.width - 32 : side * 28 - item.width / 2), 8, width - item.width - 8);
      const desiredY = clamp(item.node.y * height - item.height - 12, 8, height - item.height - 40);
      let best = null;
      for (const x of [desiredX, 8, width - item.width - 8]) {
        for (let y = 8; y <= height - item.height - 40; y += 8) {
          if (labels.some(box => x < box.x + box.width + 8 && x + item.width + 8 > box.x && y < box.y + box.height + 8 && y + item.height + 8 > box.y)) continue;
          const distance = Math.abs(x - desiredX) + Math.abs(y - desiredY);
          if (!best || distance < best.distance) best = { ...item, x, y, distance };
        }
      }
      if (!best) break;
      labels.push(best);
    }
    if (labels.length === items.length) return { height, labels };
  }
  throw new Error("Tree labels exceed their measured container");
}

export class AstTree {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "ast-tree-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.labels = document.createElement("div");
    this.labels.className = "ast-tree-labels";
    this.stage = document.createElement("div");
    this.stage.className = "ast-tree-stage";
    this.stage.append(this.canvas, this.labels);
    this.selection = document.createElement("div");
    this.selection.className = "ast-tree-selection";
    this.breadcrumb = document.createElement("nav");
    this.breadcrumb.className = "ast-tree-path";
    this.breadcrumb.setAttribute("aria-label", "Selected AST node path");
    this.detail = document.createElement("p");
    this.detail.className = "ast-tree-detail";
    this.detail.setAttribute("aria-live", "polite");
    this.collapse = document.createElement("button");
    this.collapse.type = "button";
    this.collapse.className = "ast-tree-collapse";
    this.collapse.hidden = true;
    this.collapse.addEventListener("click", () => this.toggle(this.collapseIndex, true));
    this.caption = document.createElement("p");
    this.caption.className = "ast-tree-caption";
    this.selection.append(this.breadcrumb, this.collapse, this.detail, this.caption);
    this.summary = document.createElement("p");
    this.summary.className = "ast-tree-summary sr-only";
    this.summary.textContent = "The syntax tree will appear after the example is generated.";
    container.replaceChildren(this.stage, this.selection, this.summary);
    this.keyHandler = event => this.navigate(event);
    container.addEventListener("keydown", this.keyHandler);
    this.context = this.canvas.getContext("2d");
    this.motion = false;
    this.progress = 1;
    this.frame = null;
    this.model = layoutTree(null);
    this.view = this.model;
    this.registry = new Map();
    this.path = new Set();
    this.leaf = new Image();
    this.leaf.onload = () => this.draw();
    this.leaf.src = "/ast-leaf.webp";
    this.bark = new Image();
    this.bark.onload = () => this.draw();
    this.bark.src = "/ast-bark.webp";
    this.roots = new Image();
    this.roots.onload = () => this.draw();
    this.roots.src = "/ast-roots.webp";
    this.canvas.addEventListener("pointermove", event => {
      const leaf = this.leafAt(event);
      this.canvas.style.cursor = leaf ? "pointer" : "default";
      this.preview(leaf?.index ?? null);
    });
    this.canvas.addEventListener("pointerleave", () => this.preview(null));
    this.canvas.addEventListener("click", event => {
      const leaf = this.leafAt(event);
      if (leaf) this.select(leaf.index, true);
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
    this.resize();
  }

  update(inspection, { name = "Syntax tree", filename = "" } = {}) {
    const hadTree = this.model.nodes.length > 0;
    this.inspection = inspection;
    this.model = layoutTree(inspection);
    this.registry = new Map(this.model.nodes.map(node => [node.index, node]));
    const initial = initialBranches(this.model);
    this.expanded = initial.expanded;
    this.selected = initial.selected;
    this.hovered = null;
    this.caption.textContent = `${inspection.nodes.length} AST nodes · ${this.model.leaves.length} terminal leaves`;
    this.summary.textContent = `${filename || name}: ${inspection.nodes.length} AST nodes, ${this.model.depth} levels of nesting, ${this.model.leaves.length} terminal nodes. Expand a branch to inspect its children. Select a leaf to highlight its complete parent path and Zig source. Arrow keys navigate parents and children.`;
    this.renderTree();
    this.showSelection();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.progress = this.motion && hadTree ? 0 : 1;
    this.started = performance.now();
    this.draw();
    if (this.progress < 1) this.frame = requestAnimationFrame(time => this.animate(time));
  }

  leafAt(event) {
    const bounds = this.canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    let nearest = null, distance = 30;
    for (const node of this.view.leaves) {
      const offset = Math.hypot(x - (node.x * this.width + (node.x < .5 ? -16 : 16)), y - (node.y * this.height - 22));
      if (offset < distance) { nearest = node; distance = offset; }
    }
    return nearest;
  }

  renderTree(focusIndex) {
    this.view = branchView(this.inspection, this.expanded, this.model);
    this.stage.style.minHeight = "";
    this.labels.replaceChildren();
    const controls = this.view.nodes.filter(node => {
      if (node.index === 0) return this.view.nodes.length === 1;
      if (node.depth === 1 || node.collapsed || !node.children.length) return true;
      const parent = this.registry.get(node.parent);
      const child = this.registry.get(node.children[0]);
      return !(node.children.length === 1 && child.label === node.label) &&
        !(/container_decl/.test(node.tag) && /var_decl/.test(parent?.tag));
    });
    this.controls = controls;
    this.sizeStage();
    for (const node of controls) {
      const full = this.registry.get(node.index);
      const branch = full.children.length > 0;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ast-tree-label";
      button.dataset.node = node.index;
      button.dataset.kind = node.kind;
      button.style.setProperty("--tree-color", colors[node.kind]);
      if (branch) {
        button.setAttribute("aria-expanded", String(!node.collapsed));
        const toggle = document.createElement("span");
        toggle.className = "ast-tree-toggle";
        toggle.setAttribute("aria-hidden", "true");
        toggle.textContent = node.collapsed ? "+" : "−";
        button.append(toggle);
      }
      const text = document.createElement("span");
      text.className = "ast-tree-label-text";
      text.textContent = node.tag === "enum_literal" ? `default: ${node.label}`
        : /container_decl/.test(node.tag) && node.depth > 2 ? `type: ${node.label}` : node.label;
      const identity = document.createElement("small");
      const value = node.collapsed && this.model.labels.find(label => label.node.index === node.index)?.value;
      identity.textContent = `#${node.index}${value ? ` · ${value}` : ""}`;
      text.append(identity);
      button.append(text);
      button.setAttribute("aria-label", branch
        ? `${node.collapsed ? "Expand" : "Collapse"} ${node.label} branch, node ${node.index}`
        : `Select ${node.label}, node ${node.index}, ${node.tag}`);
      button.addEventListener("click", () => branch ? this.toggle(node.index, true) : this.select(node.index, true));
      button.addEventListener("pointerenter", () => this.preview(node.index));
      button.addEventListener("pointerleave", () => this.preview(null));
      button.addEventListener("focus", () => this.select(node.index));
      this.labels.append(button);
    }
    this.resize();
    if (focusIndex != null) this.labels.querySelector(`[data-node="${focusIndex}"]`)?.focus({ preventScroll: true });
  }

  select(index, reveal = false) {
    if (!this.registry.has(index)) return;
    this.selected = index;
    this.hovered = null;
    this.showSelection(reveal);
    this.draw();
  }

  preview(index) {
    if (this.hovered === index) return;
    this.hovered = index;
    this.showSelection();
    this.draw();
  }

  toggle(index, focus = false) {
    const node = this.registry.get(index);
    if (!node?.children.length) return;
    if (this.expanded.has(index)) this.expanded.delete(index);
    else this.expanded.add(index);
    this.selected = index;
    this.hovered = null;
    this.renderTree(focus ? index : null);
    this.showSelection(true);
    this.draw();
  }

  showSelection(reveal = false) {
    const index = this.hovered ?? this.selected;
    const path = nodePath(this.model, index);
    const node = path.at(-1);
    this.active = index;
    this.path = new Set(path.map(parent => parent.index));
    this.breadcrumb.replaceChildren();
    const visiblePath = path.filter(parent => parent.index !== 0 &&
      !(/container_decl/.test(parent.tag) && /var_decl/.test(this.registry.get(parent.parent)?.tag)) &&
      !(parent.children.length === 1 && this.registry.get(parent.children[0])?.label === parent.label));
    for (const parent of visiblePath.length ? visiblePath : path) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = parent.label;
      button.title = `node #${parent.index} · ${parent.tag}`;
      button.setAttribute("aria-label", `Select ancestor ${parent.label}, node ${parent.index}`);
      if (parent.index === index) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => this.select(parent.index, true));
      this.breadcrumb.append(button);
    }
    const owner = path.slice(0, -1).reverse().find(parent => /container_field|fn_decl|var_decl/.test(parent.tag));
    const ownerKind = /container_field/.test(owner?.tag) ? "field" : owner?.tag === "fn_decl" ? "function" : "declaration";
    this.detail.textContent = node ? `node #${node.index} · ${node.tag}${owner ? ` · owned by ${ownerKind} #${owner.index}` : ""}` : "Select a branch or leaf to inspect its node.";
    const branch = path.slice().reverse().find(parent => parent.children.length &&
      (parent.index === index || parent.children.length > 1));
    this.collapseIndex = branch?.index;
    this.collapse.hidden = !branch;
    if (branch) {
      const expanded = this.expanded.has(branch.index);
      this.collapse.textContent = expanded ? "Collapse branch" : "Expand branch";
      this.collapse.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} selected ${branch.label} branch`);
    }
    for (const button of this.labels.children) {
      const selected = Number(button.dataset.node) === index;
      button.classList.toggle("selected", selected);
      if (!button.hasAttribute("aria-expanded")) button.setAttribute("aria-pressed", String(Number(button.dataset.node) === this.selected));
    }
    const scope = path.slice(0, -1).reverse().find(parent => parent.depth > 2 && /container_decl|block/.test(parent.tag));
    this.container.dispatchEvent(new CustomEvent("tree-node", { bubbles: true, detail: node ? {
      nodeIndex: node.index, firstToken: node.first_token, lastToken: node.last_token,
      contextFirstToken: scope?.first_token, contextLastToken: scope?.last_token, reveal,
    } : null }));
  }

  navigate(event) {
    const index = Number(event.target.dataset.node);
    const node = this.registry.get(index);
    if (!node || !["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "ArrowRight" && node.children.length) {
      if (!this.expanded.has(index)) this.toggle(index, true);
      else this.focusNode(node.children[0], true);
    } else if (event.key === "ArrowLeft") {
      if (this.expanded.has(index) && node.children.length) this.toggle(index, true);
      else if (node.parent != null) this.focusNode(node.parent, false);
    } else if (event.key === "Home") this.focusNode(this.model.nodes.find(parent => parent.depth === 1)?.index ?? 0);
  }

  focusNode(index, descend = true) {
    // Transparent wrapper nodes remain in the actual ancestry but do not need
    // duplicate controls. Continue through them to a visible node control.
    let node = this.registry.get(index);
    const seen = new Set();
    while (node && !seen.has(node.index)) {
      seen.add(node.index);
      const button = this.labels.querySelector(`[data-node="${node.index}"]`);
      if (button) { button.focus({ preventScroll: true }); return; }
      node = this.registry.get(descend && node.children.length ? node.children[0] : node.parent);
    }
  }

  setMotion(running) {
    this.motion = running;
    if (!running) {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
      this.progress = 1;
      this.draw();
    }
  }

  animate(time) {
    this.frame = null;
    this.progress = clamp((time - this.started) / 1150, 0, 1);
    this.draw();
    if (this.motion && this.progress < 1) this.frame = requestAnimationFrame(next => this.animate(next));
  }

  resize() {
    const { width } = this.stage.getBoundingClientRect();
    if (width !== this.width) {
      this.stage.style.minHeight = "";
    }
    this.width = width;
    this.sizeStage();
    const { height } = this.stage.getBoundingClientRect();
    this.height = height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.placeLabels();
    this.draw();
  }

  sizeStage() {
    this.stage.style.setProperty("--tree-extra-height", `${Math.max(0, (this.controls?.length || 0) - (this.width < 500 ? 8 : 12)) * 30}px`);
  }

  placeLabels() {
    if (!this.width || !this.height) { this.labelPositions = []; return; }
    const items = [...this.labels.children].map((button, index) => {
      button.hidden = false;
      button.style.maxWidth = `${Math.min(140, this.width * .42)}px`;
      return { node: this.controls[index], width: Math.min(button.offsetWidth || 100, this.width - 16), height: button.offsetHeight || 40 };
    });
    const layout = placeTreeLabels(items, this.width, this.height);
    this.stage.style.minHeight = `${layout.height}px`;
    layout.labels.forEach(({ x, y }, index) => {
      const button = this.labels.children[index];
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
    });
    this.labelPositions = layout.labels;
  }

  draw() {
    const context = this.context;
    if (!context || !this.width || !this.height) return;
    context.clearRect(0, 0, this.width, this.height);
    context.lineCap = "round";
    const growth = 1 - (1 - this.progress) ** 3;
    const scale = Math.min(this.width / 700, 1);
    const point = node => ({ x: node.x * this.width, y: node.y * this.height });
    const wood = new Path2D(), selected = new Path2D(), sap = new Path2D(), selectedSap = new Path2D();
    for (const branch of this.view.branches) {
      const start = point(branch.start), end = point(branch.end);
      const visible = clamp(growth * (this.view.depth + 1) - branch.end.depth + 1, 0, 1);
      if (!visible) continue;
      const dx = end.x - start.x, dy = end.y - start.y;
      const reach = Math.hypot(dx, dy) * .42;
      const tangent = node => {
        const x = node.direction.x * this.width, y = node.direction.y * this.height;
        const length = Math.hypot(x, y) || 1;
        return { x: x / length * reach, y: y / length * reach };
      };
      const from = tangent(branch.start), to = tangent(branch.end);
      const control1 = { x: start.x + from.x, y: start.y + from.y };
      const control2 = { x: end.x - to.x, y: end.y - to.y };
      const widthScale = .45 + scale * .55;
      const sides = [[], []];
      const trace = new Path2D();
      for (let step = 0; step <= 20; step++) {
        const t = step / 20 * visible, u = 1 - t;
        const x = u ** 3 * start.x + 3 * u * u * t * control1.x + 3 * u * t * t * control2.x + t ** 3 * end.x;
        const y = u ** 3 * start.y + 3 * u * u * t * control1.y + 3 * u * t * t * control2.y + t ** 3 * end.y;
        if (step === 0) trace.moveTo(x, y);
        else trace.lineTo(x, y);
        const tx = 3 * u * u * (control1.x - start.x) + 6 * u * t * (control2.x - control1.x) + 3 * t * t * (end.x - control2.x);
        const ty = 3 * u * u * (control1.y - start.y) + 6 * u * t * (control2.y - control1.y) + 3 * t * t * (end.y - control2.y);
        const length = Math.hypot(tx, ty) || 1;
        const flare = branch.from === 0 ? 1 + .35 * (1 - t) ** 5 : 1;
        const radius = (branch.width * (1 - t) + branch.end.thickness * t) * widthScale / 2 * flare;
        sides[0].push({ x: x - ty / length * radius, y: y + tx / length * radius });
        sides[1].push({ x: x + ty / length * radius, y: y - tx / length * radius });
      }
      const path = new Path2D();
      path.moveTo(sides[0][0].x, sides[0][0].y);
      for (const position of [...sides[0].slice(1), ...sides[1].reverse()]) path.lineTo(position.x, position.y);
      if (branch.from === 0) path.bezierCurveTo(start.x + branch.width * .3, start.y + 7,
        start.x - branch.width * .3, start.y + 9, sides[0][0].x, sides[0][0].y);
      path.closePath();
      wood.addPath(path);
      sap.addPath(trace);
      if (this.path.has(branch.from) && this.path.has(branch.to)) {
        selected.addPath(path);
        selectedSap.addPath(trace);
      }
    }
    let texture = null;
    if (this.bark.complete && this.bark.naturalWidth) {
      texture = context.createPattern(this.bark, "repeat");
      texture.setTransform(new DOMMatrix().translate(this.width * .5, 0).scale(.13));
    }
    // One fill keeps the bark grain continuous through every semantic joint.
    // A shared silhouette shadow avoids outlining internal segment end caps.
    context.fillStyle = texture || "#52634b";
    context.shadowColor = "#b6d4be50";
    context.shadowBlur = 3;
    context.fill(wood);
    context.shadowBlur = 0;
    context.fillStyle = "#a1f0d012";
    context.fill(wood);
    const activeColor = this.registry.get(this.active)?.kind === "value" ? "#f4ba93" : "#a1f0d0";
    context.fillStyle = activeColor + "30";
    context.fill(selected);
    context.strokeStyle = "#a1f0d030";
    context.shadowColor = "#a1f0d060";
    context.shadowBlur = 4;
    context.lineWidth = .7;
    context.stroke(sap);
    context.strokeStyle = activeColor;
    context.shadowColor = activeColor;
    context.shadowBlur = 9;
    context.lineWidth = 1.5;
    context.stroke(selectedSap);
    context.shadowBlur = 0;
    // A single root-node illustration grounds the changing silhouette; it does
    // not add branches or leaves to the inspected topology.
    if (this.view.branches.length && this.roots.complete && this.roots.naturalWidth) {
      const root = point(this.view.nodes[0]);
      const width = this.view.nodes[0].thickness * 4 * (.45 + scale * .55);
      const height = width / 2;
      context.save();
      context.globalAlpha = Math.min(1, growth * 4);
      context.drawImage(this.roots, root.x - width / 2, root.y - height * .75, width, height);
      context.restore();
    }
    if (this.leaf.complete && this.leaf.naturalWidth) {
      for (const node of this.view.leaves) {
        const visible = clamp((growth * (this.view.depth + 1) - node.depth) * 2, 0, 1);
        if (!visible) continue;
        const position = point(node);
        const size = (52 + noise(node.index + 100) * 18) * (.65 + scale * .35);
        context.save();
        context.globalAlpha = visible * (node.index === this.active ? 1 : .65);
        context.translate(position.x, position.y);
        context.rotate((node.x < .5 ? -.8 : .8) + (noise(node.index + 13) - .5) * .7);
        if (node.kind === "type") context.filter = "hue-rotate(115deg) saturate(.9)";
        else if (node.kind === "value") context.filter = "sepia(.8) saturate(1.5) hue-rotate(330deg)";
        context.drawImage(this.leaf, -size * .5, -size * .94, size, size);
        context.restore();
      }
    }
    // Registered nonterminal junctions remain visible when their descendants
    // are collapsed; they never acquire a terminal leaf sprite.
    for (const node of this.view.nodes.filter(node => node.collapsed || this.expanded?.has(node.index) && node.depth > 2 && node.children.length > 1)) {
      const position = point(node);
      context.beginPath();
      context.arc(position.x, position.y, 3, 0, Math.PI * 2);
      context.fillStyle = this.path.has(node.index) ? activeColor : "#aac9b6";
      context.fill();
    }
    context.globalAlpha = 1;
    for (const { x, y, width, height, node } of this.labelPositions || []) {
      const position = point(node);
      context.strokeStyle = this.active === node.index ? "#f4ba93" : "#a1c3b175";
      context.lineWidth = .7;
      context.beginPath();
      context.moveTo(x + width / 2, y + height + 3);
      context.lineTo(position.x, position.y);
      context.stroke();
    }
    this.labels.style.opacity = String(clamp((growth - .55) / .45, 0, 1));
  }

  destroy() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.container.removeEventListener("keydown", this.keyHandler);
    this.leaf.onload = null;
    this.bark.onload = null;
    this.roots.onload = null;
    this.container.replaceChildren();
  }
}
