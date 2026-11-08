import { highlightJson, highlightZig } from "./highlight.js";

const siteRoot = new URL("./", import.meta.url);

if (location.pathname === siteRoot.pathname && location.hash.startsWith("#code=")) {
  // Preserve links shared before the playground moved to /examples/.
  location.replace(new URL("examples/" + location.hash, siteRoot).href);
} else {
  for (const code of document.querySelectorAll("pre code.language-zig, pre code.zig")) {
    code.innerHTML = highlightZig(code.textContent);
  }
  for (const code of document.querySelectorAll("pre code.language-json, pre code.json")) {
    code.innerHTML = highlightJson(code.textContent);
  }
}
