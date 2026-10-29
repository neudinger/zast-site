const storageKey = "zast-code-reading-v1";
const fontSizes = [14, 16, 18, 20, 24, 28];

// Reading preferences are separate from saved inputs, selected examples, and views.
export function initCodeReadingControls(surface, storage) {
  const size = surface.querySelector("[data-code-size]");
  const wrap = surface.querySelector("[data-code-wrap]");
  const focus = surface.querySelector("[data-code-focus]");
  if (!size || !wrap) return;
  let preferences = { fontSize: null, wrap: false };
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) || "null");
    if (saved) preferences = {
      fontSize: fontSizes.includes(saved.fontSize) ? saved.fontSize : null,
      wrap: saved.wrap === true,
    };
  } catch {}

  function apply() {
    size.value = preferences.fontSize == null ? "" : String(preferences.fontSize);
    wrap.checked = preferences.wrap;
    surface.classList.toggle("wrap-code", preferences.wrap);
    if (preferences.fontSize == null) surface.style.removeProperty("--code-font-size");
    else surface.style.setProperty("--code-font-size", preferences.fontSize / 16 + "rem");
  }

  function save() {
    apply();
    try { storage?.setItem(storageKey, JSON.stringify(preferences)); } catch {}
  }

  size.addEventListener("change", () => {
    const selected = Number(size.value);
    preferences.fontSize = fontSizes.includes(selected) ? selected : null;
    save();
  });
  wrap.addEventListener("change", () => {
    preferences.wrap = wrap.checked;
    save();
  });

  function setFocus(focused) {
    surface.classList.toggle("code-focused", focused);
    focus.setAttribute("aria-pressed", String(focused));
    focus.textContent = focused ? "Show JSON input" : "Read full width";
  }
  focus?.addEventListener("click", () => {
    setFocus(!surface.classList.contains("code-focused"));
  });
  surface.addEventListener("keydown", event => {
    if (focus && event.key === "Escape" && surface.classList.contains("code-focused")) {
      event.preventDefault();
      setFocus(false);
      focus.focus();
    }
  });
  apply();
}

if (typeof document !== "undefined") {
  let storage;
  try { storage = localStorage; } catch {}
  for (const surface of document.querySelectorAll("[data-reading-surface]")) {
    initCodeReadingControls(surface, storage);
  }
}
