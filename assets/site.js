import { highlightJson, highlightZig } from "./highlight.js";

for (const code of document.querySelectorAll("pre code.language-zig, pre code.zig")) {
  code.innerHTML = highlightZig(code.textContent);
}
for (const code of document.querySelectorAll("pre code.language-json, pre code.json")) {
  code.innerHTML = highlightJson(code.textContent);
}
