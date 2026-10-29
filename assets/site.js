import { highlightZig } from "./highlight.js";
import { highlightApiExamples } from "./api-examples.js";

const siteRoot = new URL("./", import.meta.url);

// Keep the shared skip link out of the API viewer's symbol hash routing.
if (document.body.dataset.page === "api") {
  highlightApiExamples(document.querySelector(".api-content"));
  document.querySelector(".skip-link").addEventListener("click", event => {
    event.preventDefault();
    const content = document.getElementById("site-content");
    content.setAttribute("tabindex", "-1");
    content.focus();
  });
} else if (location.pathname === siteRoot.pathname && location.hash.startsWith("#code=")) {
  // Preserve links shared before the playground moved to /examples/.
  location.replace(new URL("examples/" + location.hash, siteRoot).href);
} else {
  for (const code of document.querySelectorAll("pre code.language-zig, pre code.zig")) {
    code.innerHTML = highlightZig(code.textContent);
  }
}
