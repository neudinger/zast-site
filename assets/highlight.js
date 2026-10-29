const keywords = new Set([
  "addrspace", "align", "allowzero", "and", "anyframe", "anytype", "asm", "break",
  "callconv", "catch", "comptime", "const", "continue", "defer", "else", "enum",
  "errdefer", "error", "export", "extern", "fn", "for", "if", "inline", "linksection",
  "noalias", "noinline", "nosuspend", "opaque", "or", "orelse", "packed", "pub",
  "resume", "return", "struct", "suspend", "switch", "test", "threadlocal", "try",
  "union", "unreachable", "var", "volatile", "while", "null", "true", "false", "undefined",
]);

export function escapeHtml(text) {
  return text.replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

export function highlightJson(text) {
  return text.split(/("(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?\b)/g).map((part, index) =>
    index % 2 ? '<span class="syntax-' + (part.startsWith('"') ? "string" : "number") + '">' + escapeHtml(part) + '</span>' : escapeHtml(part)
  ).join("");
}

export function highlightZig(text) {
  const pattern = /\/\/.*|"(?:\\.|[^"\\])*"|@[A-Za-z_][A-Za-z_0-9]*|\b[A-Za-z_][A-Za-z_0-9]*\b|\b[0-9]+\b/g;
  let cursor = 0;
  let highlighted = "";
  for (const token of text.matchAll(pattern)) {
    highlighted += escapeHtml(text.slice(cursor, token.index));
    const spelling = token[0];
    let kind = "";
    if (spelling.startsWith("//")) kind = "comment";
    else if (spelling.startsWith('"')) kind = "string";
    else if (spelling.startsWith("@")) kind = "builtin";
    else if (keywords.has(spelling)) kind = "keyword";
    else if (/^\d+$/.test(spelling)) kind = "number";
    else if (/^[ui]\d+$/.test(spelling) || ["std", "zast", "AstContext", "EnumDeclaration", "Field", "Allocator"].includes(spelling)) kind = "type";
    highlighted += kind ? '<span class="syntax-' + kind + '">' + escapeHtml(spelling) + "</span>" : escapeHtml(spelling);
    cursor = token.index + spelling.length;
  }
  return highlighted + escapeHtml(text.slice(cursor));
}

