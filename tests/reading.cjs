const assert = require("node:assert/strict");

async function checkReading() {
  const { initCodeReadingControls } = await import("../assets/reading.js");
  class Control extends EventTarget {
    constructor() { super(); this.attributes = new Map(); this.value = ""; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    focus() { this.focused = true; }
  }
  function fixture(storage, focusControl = true) {
    const size = new Control(), wrap = new Control(), focus = new Control();
    const classes = new Set(), styles = new Map();
    const surface = Object.assign(new EventTarget(), {
      querySelector: selector => ({
        "[data-code-size]": size,
        "[data-code-wrap]": wrap,
        "[data-code-focus]": focusControl ? focus : null,
      })[selector],
      classList: {
        contains: name => classes.has(name),
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      },
      style: {
        setProperty: (name, value) => styles.set(name, value),
        removeProperty: name => styles.delete(name),
      },
    });
    initCodeReadingControls(surface, storage);
    return { surface, size, wrap, focus, classes, styles };
  }
  const saved = new Map([["zast-playground-v1", "saved input must stay intact"]]);
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const first = fixture(storage);
  assert.equal(first.size.value, "");
  assert.equal(first.wrap.checked, false);
  first.size.value = "18";
  first.size.dispatchEvent(new Event("change"));
  assert.equal(first.styles.get("--code-font-size"), "1.125rem");
  first.wrap.checked = true;
  first.wrap.dispatchEvent(new Event("change"));
  assert(first.classes.has("wrap-code"));
  assert.equal(saved.get("zast-playground-v1"), "saved input must stay intact");
  first.size.value = "28";
  first.size.dispatchEvent(new Event("change"));
  assert.equal(first.styles.get("--code-font-size"), "1.75rem", "Code can double its default size");
  const nextPage = fixture(storage, false);
  assert.equal(nextPage.size.value, "28");
  assert(nextPage.wrap.checked);
  nextPage.size.value = "";
  nextPage.size.dispatchEvent(new Event("change"));
  assert(!nextPage.styles.has("--code-font-size"), "Default restores surface typography");

  first.focus.dispatchEvent(new Event("click"));
  assert(first.classes.has("code-focused"));
  assert.equal(first.focus.attributes.get("aria-pressed"), "true");
  assert.equal(first.focus.textContent, "Show JSON input");
  const escape = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
  first.surface.dispatchEvent(escape);
  assert(!first.classes.has("code-focused"));
  assert.equal(first.focus.attributes.get("aria-pressed"), "false");
  assert(first.focus.focused && escape.defaultPrevented);
  assert(!fixture(storage).classes.has("code-focused"), "Focus mode is transient");

  for (const invalid of ["{broken", '{"fontSize":999,"wrap":"true"}', "null"]) {
    const restored = fixture({ getItem: () => invalid }, false);
    assert.equal(restored.size.value, "");
    assert(!restored.wrap.checked);
  }
  const unavailable = fixture({
    getItem() { throw new Error("Storage unavailable"); },
    setItem() { throw new Error("Storage unavailable"); },
  });
  unavailable.size.value = "16";
  unavailable.size.dispatchEvent(new Event("change"));
  assert.equal(unavailable.styles.get("--code-font-size"), "1rem");
}

module.exports = { checkReading };
if (require.main === module) checkReading().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
