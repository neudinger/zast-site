import { highlightJson, highlightZig } from "./highlight.js";
import { catalog, examples, buildApiSource, exampleInfo } from "./examples.js";
import { Rotation } from "./rotation.js";
import { AstTree, tokenLines } from "./tree.js";

const siteRoot = new URL("./", import.meta.url);
const compact = document.body.dataset.page === "home";

const elements = Object.fromEntries([
  "json-input", "input-lines", "input-highlight", "input-size", "input-error", "example-select",
  "reset-button", "share-button", "download-button", "copy-button",
  "zig-output", "api-output", "output-filename", "output-status", "output-metrics",
  "node-rows", "token-rows", "node-count", "token-count", "node-detail", "toast",
  "example-description", "example-guide", "example-position", "rotation-button", "rotation-status", "rotation-progress",
  "previous-example-button", "next-example-button",
].map(identifier => [identifier, document.getElementById(identifier)]));

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const storageKey = compact ? "zast-home-example-v3" : "zast-playground-v1";
const viewNames = compact ? ["zig"] : ["zig", "api", "ast", "tokens"];
let exampleInput = "";
const readInput = () => compact ? exampleInput : elements["json-input"].value;
function setInput(value) {
  if (compact) exampleInput = value;
  else elements["json-input"].value = value;
}

let wasmApi = null;
let activeView = "zig";
let lastOutput = "";
let lastBuilder = "";
let lastDescription = null;
let currentInspection = null;
let generationTimer = null;
let toastTimer = null;
let rotation = null;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const treeContainer = document.getElementById("ast-tree");
const tree = treeContainer ? new AstTree(treeContainer) : null;
let treeLines = null;

treeContainer?.addEventListener("tree-node", event => {
  const range = event.detail;
  const first = range && treeLines?.[range.firstToken]?.[0];
  const last = range && treeLines?.[range.lastToken]?.[1];
  const contextFirst = range && treeLines?.[range.contextFirstToken]?.[0];
  const contextLast = range && treeLines?.[range.contextLastToken]?.[1];
  [...elements["zig-output"].children].forEach((row, index) => {
    row.classList.toggle("tree-selected", first != null && last != null && index >= first && index <= last);
    row.classList.toggle("tree-context", contextFirst != null && contextLast != null && index >= contextFirst && index <= contextLast);
  });
  if (range?.reveal && first != null) {
    const row = elements["zig-output"].children[first];
    const pane = elements["zig-output"].closest(".output-content");
    if (row && pane) pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight / 2 + row.clientHeight / 2;
  }
});

// Both surfaces use the same ordered catalogue. Selection never edits a saved
// playground draft until the user explicitly chooses or edits an example.
elements["example-select"].replaceChildren();
for (const group of [...new Set(catalog.map(entry => entry.group))]) {
  const options = document.createElement("optgroup");
  options.label = group;
  for (const entry of catalog.filter(entry => entry.group === group)) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = (entry.number ? entry.number + ". " : "") + entry.title;
    options.append(option);
  }
  elements["example-select"].append(options);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3200);
}

function saveState() {
  if (encoder.encode(readInput()).length > 4096) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      ...(compact ? {} : { input: readInput() }),
      example: elements["example-select"].value,
      view: activeView,
    }));
  } catch {}
}

function selectView(view, save = true) {
  if (!viewNames.includes(view)) return;
  activeView = view;
  for (const name of viewNames) {
    const tab = document.getElementById("tab-" + name);
    if (tab) {
      tab.setAttribute("aria-selected", String(name === view));
      tab.tabIndex = name === view ? 0 : -1;
      document.getElementById("panel-" + name).hidden = name !== view;
    }
  }
  elements["copy-button"].querySelector("[data-copy-label]").textContent = view === "zig" || view === "api" ? "Copy" : "Copy JSON";
  if (save) saveState();
}

function renderCode(text, container) {
  container.replaceChildren();
  text.replace(/\n$/, "").split("\n").forEach((line, index) => {
    const row = document.createElement("div");
    row.className = "code-line";
    const number = document.createElement("span");
    number.className = "line-number";
    number.setAttribute("aria-hidden", "true");
    number.textContent = index + 1;
    const code = document.createElement("code");
    code.innerHTML = highlightZig(line) || " ";
    row.append(number, code);
    container.append(row);
  });
}

function appendCells(row, values) {
  for (const value of values) {
    const cell = document.createElement("td");
    cell.textContent = String(value);
    row.append(cell);
  }
}

function inspectNode(node, row) {
  for (const entry of elements["node-rows"].children) entry.classList.remove("selected");
  row.classList.add("selected");
  const token = currentInspection.tokens[node.main_token];
  elements["node-detail"].textContent =
    "node[" + node.index + "] ." + node.tag + " → token[" + node.main_token + "] ." +
    token.tag + " " + JSON.stringify(token.spelling);
}

function renderInspection(inspection) {
  currentInspection = inspection;
  if (compact) return;
  elements["node-count"].textContent = inspection.nodes.length + " nodes";
  elements["token-count"].textContent = inspection.tokens.length + " tokens";
  elements["node-detail"].textContent = "Select a node to inspect its main token.";
  elements["node-rows"].replaceChildren();
  elements["token-rows"].replaceChildren();
  for (const node of inspection.nodes) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "node-select";
    button.textContent = node.index;
    button.setAttribute("aria-label", "Inspect node " + node.index + ", " + node.tag);
    button.addEventListener("click", () => inspectNode(node, row));
    cell.append(button);
    row.append(cell);
    const token = inspection.tokens[node.main_token];
    appendCells(row, [node.tag, node.main_token + " · " + (token.spelling || "EOF")]);
    elements["node-rows"].append(row);
  }
  for (const token of inspection.tokens) {
    const row = document.createElement("tr");
    appendCells(row, [token.index, token.tag, token.spelling || "(EOF)"]);
    elements["token-rows"].append(row);
  }
}

function updateInputMetadata() {
  if (!compact) {
    elements["input-lines"].textContent = readInput().split("\n").map((_, index) => index + 1).join("\n");
    elements["input-size"].textContent = encoder.encode(readInput()).length + " B";
    elements["input-highlight"].innerHTML = highlightJson(readInput()) + "\n";
    elements["json-input"].classList.add("highlighted");
  }
  for (const link of document.querySelectorAll(".open-playground")) {
    link.href = encoder.encode(readInput()).length <= 4096 ? shareUrl().href : new URL("examples/", siteRoot).href;
  }
}

function readMemory(pointer, length) {
  // Each call may grow Wasm memory; always create a fresh view.
  return decoder.decode(new Uint8Array(wasmApi.memory.buffer, pointer, length));
}

const friendlyErrors = {
  InvalidIdentifier: "Use ordinary Zig identifier names (letters, digits, underscores). Keywords and '_' are not accepted.",
  TooManyFields: "This playground supports up to 32 enum fields.",
  DuplicateField: "Each enum field needs a unique name.",
  DuplicateValue: "Two fields resolve to the same integer value.",
  UnsupportedBackingType: "Choose u8, u16, u32, i8, i16, or i32 for the backing type.",
  ValueOutOfRange: "A field value does not fit the selected backing type.",
  MissingBackingType: "Explicit values and non_exhaustive require an explicit backing_type.",
  InputTooLarge: "Keep the JSON description below 4 KiB.",
  UnexpectedEndOfInput: "The JSON is incomplete. Finish the current value or closing bracket.",
  UnknownField: "The JSON contains an unsupported property for this example.",
  UnknownExample: "Choose an example ID from the catalogue.",
  UnsupportedSchema: "These schema lessons accept UByte enums and UInt object fields only.",
  TooManyDeclarations: "Keep schema input to at most 16 declarations.",
  InvalidEnumTag: "The example or schema type is not supported.",
  MissingField: "An enum needs name and fields; a schema recipe needs its schema object.",
  UnexpectedToken: "Check the JSON syntax and the types of its values.",
  InvalidNumber: "Use integer values that fit the selected backing type.",
  OutOfMemory: "The generator ran out of memory. Reload the page before continuing.",
};

function generate() {
  updateInputMetadata();
  if (!wasmApi) return;
  try {
    const input = encoder.encode(readInput());
    if (input.length > wasmApi.inputCapacity()) throw new Error("InputTooLarge");
    new Uint8Array(wasmApi.memory.buffer, wasmApi.inputPointer(), input.length).set(input);
    const started = performance.now();
    const result = wasmApi.generate(input.length);
    const duration = performance.now() - started;
    const rendered = readMemory(wasmApi.outputPointer(), wasmApi.outputLength());
    if (result !== 0) throw new Error(rendered || "GenerationFailed");
    const description = JSON.parse(readInput());
    const inspection = JSON.parse(readMemory(wasmApi.inspectPointer(), wasmApi.inspectLength()));
    lastOutput = rendered;
    lastDescription = description;
    lastBuilder = buildApiSource(description, !compact);
    renderCode(lastOutput, elements["zig-output"]);
    renderCode(lastBuilder, elements["api-output"]);
    renderInspection(inspection);
    if (compact && !reducedMotion.matches) {
      const editors = document.querySelector(".example-editors");
      editors.getAnimations().forEach(animation => animation.cancel());
      editors.animate([{ opacity: 0, transform: "translateY(5px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 260, easing: "ease-out" });
    }
    const info = exampleInfo(description, compact);
    if (tree) {
      treeLines = tokenLines(inspection, rendered);
      tree.update(inspection, { name: info.filename.replace(/\.zig$/, ""), filename: info.filename });
    }
    elements["output-filename"].textContent = info.filename;
    elements["example-description"].textContent = info.description;
    const selected = info.entry;
    if (selected) elements["example-select"].value = selected.id;
    elements["example-guide"].href = new URL("docs/examples/#" + (selected?.id || "status"), siteRoot).href;
    elements["example-position"].textContent = selected ? String(catalog.indexOf(selected) + 1).padStart(2, "0") + " / " + catalog.length : "Custom";
    elements["output-status"].textContent = "Generated locally · " + info.title;
    elements["output-metrics"].textContent = inspection.nodes.length + " nodes · " + duration.toFixed(1) + " ms";
    elements["input-error"].hidden = true;
    elements["json-input"]?.removeAttribute("aria-invalid");
    elements["copy-button"].disabled = false;
    elements["download-button"].disabled = false;
  } catch (failure) {
    elements["input-error"].textContent = friendlyErrors[failure.message] || failure.message;
    elements["input-error"].hidden = false;
    elements["json-input"]?.setAttribute("aria-invalid", "true");
    elements["output-status"].textContent = lastOutput ? "Input error · last valid output" : "Input error";
    elements["output-metrics"].textContent = "";
    rotation?.stop();
  }
}

function formatExample(description) {
  return JSON.stringify(description, null, 2);
}

function loadExample(name) {
  if (!examples[name]) return;
  elements["example-select"].value = name;
  setInput(formatExample(examples[name].input));
  generate();
  saveState();
  for (const pane of document.querySelectorAll(".output-content")) pane.scrollTop = 0;
}

function stepExample(direction) {
  const current = catalog.findIndex(entry => entry.id === elements["example-select"].value);
  loadExample(catalog[(current + direction + catalog.length) % catalog.length].id);
}

async function copyText(text, success) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(success);
  } catch {
    if (activeView === "zig" || activeView === "api") {
      const range = document.createRange();
      range.selectNodeContents(elements[activeView === "api" ? "api-output" : "zig-output"]);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    showToast("Clipboard unavailable. Select and copy the text, or download the Zig file.");
  }
}

for (const view of viewNames) {
  document.getElementById("tab-" + view)?.addEventListener("click", () => selectView(view));
}
document.querySelector(".output-tabs")?.addEventListener("keydown", event => {
  const selected = viewNames.indexOf(activeView);
  const next = event.key === "ArrowRight" ? viewNames[(selected + 1) % viewNames.length]
    : event.key === "ArrowLeft" ? viewNames[(selected + viewNames.length - 1) % viewNames.length]
    : event.key === "Home" ? viewNames[0] : event.key === "End" ? viewNames.at(-1) : null;
  if (next) {
    event.preventDefault();
    selectView(next);
    document.getElementById("tab-" + next).focus();
  }
});
elements["json-input"]?.addEventListener("input", () => {
  updateInputMetadata();
  clearTimeout(generationTimer);
  generationTimer = setTimeout(() => { generate(); saveState(); }, 250);
});
elements["json-input"]?.addEventListener("scroll", () => {
  elements["input-lines"].scrollTop = elements["json-input"].scrollTop;
  elements["input-highlight"].scrollTop = elements["json-input"].scrollTop;
  elements["input-highlight"].scrollLeft = elements["json-input"].scrollLeft;
});
elements["example-select"].addEventListener("change", () => {
  rotation?.stop();
  loadExample(elements["example-select"].value);
});
elements["reset-button"].addEventListener("click", () => {
  loadExample(elements["example-select"].value);
  showToast("Example restored");
});
elements["copy-button"].addEventListener("click", () => {
  const contents = activeView === "zig" ? lastOutput : activeView === "api" ? lastBuilder
    : JSON.stringify(currentInspection[activeView === "ast" ? "nodes" : "tokens"], null, 2);
  copyText(contents, activeView === "zig" ? "Zig source copied" : "View copied");
});
elements["download-button"].addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([lastOutput], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exampleInfo(lastDescription).filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Zig file downloaded");
});
function shareUrl() {
  const input = encoder.encode(readInput());
  const encoded = btoa(String.fromCharCode(...input)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const url = new URL("examples/", siteRoot);
  url.hash = "code=" + encoded;
  return url;
}

elements["share-button"].addEventListener("click", async () => {
  const input = encoder.encode(readInput());
  if (input.length > 4096) return showToast("Reduce the description below 4 KiB to share it.");
  const url = shareUrl();
  if (!compact) history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url.href);
    showToast("Playground URL copied. Site access rules still apply.");
  } catch {
    if (compact) showToast("Clipboard unavailable. Open the playground to share this example.");
    else showToast("Share URL is in the address bar. Site access rules still apply.");
  }
});

function restoreInput() {
  if (compact) {
    let selected = "constant";
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (examples[saved?.example]) selected = saved.example;
    } catch {}
    elements["example-select"].value = selected;
    setInput(formatExample(examples[selected].input));
    updateInputMetadata();
    return;
  }
  const requested = new URLSearchParams(location.search).get("example");
  if (examples[requested] && !location.hash.startsWith("#code=")) {
    elements["example-select"].value = requested;
    setInput(formatExample(examples[requested].input));
    updateInputMetadata();
    return;
  }
  let restored = false;
  const hash = window.location.hash;
  if (hash.startsWith("#code=")) {
    try {
      const encoded = hash.slice(6);
      if (encoded.length > 5500) throw new Error("InputTooLarge");
      const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), value => value.charCodeAt(0));
      if (bytes.length > 4096) throw new Error("InputTooLarge");
      setInput(decoder.decode(bytes));
      restored = true;
    } catch { showToast("The shared description could not be loaded."); }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (saved && !restored && typeof saved.input === "string" && encoder.encode(saved.input).length <= 4096) {
      setInput(saved.input);
      if (examples[saved.example]) elements["example-select"].value = saved.example;
      selectView(saved.view, false);
      restored = true;
    }
  } catch {}
  if (!restored) setInput(formatExample(examples.constant.input));
  updateInputMetadata();
}

if (compact) {
  rotation = new Rotation({
    next: () => stepExample(1),
    changed({ enabled, running, delay }) {
      tree?.setMotion(running && !reducedMotion.matches);
      elements["rotation-button"].textContent = enabled ? "Pause" : "Play";
      elements["rotation-button"].setAttribute("aria-label", (enabled ? "Pause" : "Start") + " automatic example rotation");
      elements["rotation-status"].textContent = running ? "Every " + delay / 1000 + "s" : enabled ? "Paused while reading" : "Autoplay paused";
      elements["rotation-progress"].getAnimations().forEach(animation => animation.cancel());
      if (running && !reducedMotion.matches) elements["rotation-progress"].animate(
        [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: delay, fill: "forwards" },
      );
      try { localStorage.setItem("zast-home-rotation-v1", String(enabled)); } catch {}
    },
  });
  const showcase = document.querySelector(".home-example");
  showcase.addEventListener("mouseenter", () => rotation.hold("hover", true));
  showcase.addEventListener("mouseleave", () => rotation.hold("hover", false));
  showcase.addEventListener("focusin", event => {
    if (event.target !== elements["rotation-button"]) rotation.stop();
  });
  treeContainer?.addEventListener("mouseenter", () => rotation.hold("tree", true));
  treeContainer?.addEventListener("mouseleave", () => rotation.hold("tree", false));
  treeContainer?.addEventListener("focusin", () => rotation.stop());
  document.addEventListener("visibilitychange", () => rotation.hold("hidden", document.hidden));
  reducedMotion.addEventListener("change", event => { if (event.matches) rotation.stop(); });
  elements["rotation-button"].addEventListener("click", () => rotation.enabled ? rotation.stop() : rotation.start());
  for (const [identifier, direction] of [["previous-example-button", -1], ["next-example-button", 1]]) {
    elements[identifier].addEventListener("click", () => {
      rotation.stop();
      stepExample(direction);
    });
  }
}

restoreInput();
selectView(activeView, false);

try {
  const response = await fetch(document.body.dataset.wasm);
  if (!response.ok) throw new Error("Generator download failed (" + response.status + ")");
  const result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  wasmApi = result.instance.exports;
  generate();
  if (rotation) {
    let autoplay = !reducedMotion.matches;
    try { autoplay &&= localStorage.getItem("zast-home-rotation-v1") !== "false"; } catch {}
    rotation.hold("hidden", document.hidden);
    if (autoplay) rotation.start();
    else rotation.stop();
  }
} catch (failure) {
  tree?.setMotion(false);
  if (treeContainer) {
    treeContainer.querySelector(".ast-tree-caption").textContent = "Tree unavailable · generator could not load";
    treeContainer.querySelector(".ast-tree-summary").textContent = "The syntax tree requires the WebAssembly generator.";
  }
  elements["output-status"].textContent = "Generator unavailable";
  elements["input-error"].textContent = "Could not load the WebAssembly generator. " + failure.message;
  elements["input-error"].hidden = false;
  renderCode("// Reload the page to try again.", elements["zig-output"]);
}
