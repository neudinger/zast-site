import { highlightZig } from "./highlight.js";

// Zig's API Markdown renderer drops fence languages. Require recognizable Zig
// syntax for unlabelled examples; ambiguous output and shell blocks stay plain.
export function isZigExample(source) {
  if (/^\s*(?:[$>]\s|(?:zig|zvm|git|npm|node|curl)\s)/m.test(source)) return false;
  return /^\s*(?:pub\s+(?:const|var|fn)\b|(?:inline|export|extern)\s+fn\b)/m.test(source) ||
    /^\s*(?:fn\s+\w+\s*\(|test\s+"|(?:const|var)\s+\w+\s*:)/m.test(source) ||
    /^\s*(const|var)\s+\w+\s*=\s*(?:@|(?:packed|struct|enum|union|opaque|error)\b)/m.test(source) ||
    /^\s*(?:try|defer)\s+[\w@]/m.test(source);
}

// Observe documentation only. Compiler source, signatures and doctests retain
// their token spans, symbol links and line anchors unchanged.
export function highlightApiExamples(root, Observer = MutationObserver) {
  if (!root) return null;
  const highlighted = new WeakMap();
  const documentation = "#tldDocs, .fieldDocs, #listParams, #listFns dd, " +
    "#listGlobalVars td:last-child, #listValues td:last-child";
  const update = () => {
    for (const code of root.querySelectorAll("pre > code")) {
      if (!code.closest(documentation) || code.childElementCount) continue;
      if (highlighted.get(code) === code.textContent) continue;
      const language = [...code.classList].find(name => name.startsWith("language-"));
      if (language && language !== "language-zig") continue;
      if (language !== "language-zig" && !code.classList.contains("zig") &&
          !isZigExample(code.textContent)) continue;
      const source = code.textContent;
      highlighted.set(code, source);
      code.innerHTML = highlightZig(source);
    }
  };
  update();
  const observer = new Observer(update);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return observer;
}
