import { catalog } from "./catalog.js";
import { highlightZig } from "./highlight.js";
import { companionFor, createApiIndex, loadApiIndex, searchEntries } from "./docs-model.js";

const shell = document.querySelector("[data-docs]");
if (shell) initializeDocs();

function initializeDocs() {
  const root = new URL("./", import.meta.url);
  const apiUrl = new URL("docs/api/", root);
  const isApi = document.body.dataset.page === "api";
  const main = shell.querySelector(".docs-main");
  const article = shell.querySelector(".docs-prose");
  const compiler = shell.querySelector(".api-content");
  const sidebar = shell.querySelector(".docs-sidebar");
  const menu = shell.querySelector("#docs-menu");
  const menuButton = shell.querySelector("[data-menu-open]");
  const searchDialog = shell.querySelector("[data-search-dialog]");
  const queryInput = shell.querySelector("#docs-query");
  const resultList = shell.querySelector("#docs-results");
  const searchStatus = shell.querySelector("[data-search-status]");
  const trigger = shell.querySelector("[data-search-open]");
  const guideLinks = [...shell.querySelectorAll(".docs-guide-tree > li > a")];
  const docEntries = guideLinks.map(link => ({
    title: link.textContent, href: link.href, description: "Documentation guide", kind: "Guide",
  }));
  docEntries.push(...catalog.map(entry => ({
    title: entry.title, href: new URL("docs/examples/#" + entry.id, root).href,
    description: entry.description || entry.group, kind: "Example",
  })));
  let apiIndex;
  let apiPromise;
  let apiFailure = false;
  let apiEntries = [];
  let results = [];
  let selection = 0;
  let sectionObserver;
  let frame;
  let companionPath = "";
  let lastSectionNavigation = "";
  let guidePromise;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function icon(name) {
    const image = element("img", "icon");
    image.src = new URL("icons/" + name + ".svg", root);
    image.alt = "";
    image.width = image.height = 16;
    return image;
  }
  function link(text, href, className) {
    const anchor = element("a", className, text);
    anchor.href = href;
    return anchor;
  }
  function finishIndex(index) {
    if (apiIndex) return apiIndex;
    apiIndex = index;
    const unique = new Map(index.symbols.map(symbol => [symbol.path, symbol]));
    apiEntries = [...unique.values()].map(symbol => ({
      title: symbol.path, href: new URL(symbol.href, apiUrl).href,
      description: symbol.category === 3 ? "Public function" : "Public declaration", kind: "API",
    }));
    if (isApi) buildSymbolTree(index.roots);
    if (searchDialog.open) renderSearch();
    return index;
  }
  function ensureIndex() {
    if (apiIndex) return Promise.resolve(apiIndex);
    if (!apiPromise) apiPromise = loadApiIndex(root, isApi && viewerReady()
      ? window.wasm.instance.exports : null).then(finishIndex).catch(() => {
      apiFailure = true;
      apiPromise = null;
      if (searchDialog.open) renderSearch();
    });
    return apiPromise;
  }
  function viewerReady() {
    const status = compiler.querySelector("#status");
    return window.wasm?.instance?.exports && (apiIndex ||
      status.classList.contains("hidden") || status.textContent.trim() !== "Loading...");
  }

  function anchorFor(heading, used) {
    const parent = heading.parentElement;
    if (heading.id) return heading.id;
    // SuperMD places an authored section ID on its containing div.
    if (parent.id && parent.closest(".docs-prose") &&
        parent.querySelector("h2, h3") === heading) return parent.id;
    const base = "doc-section-" + heading.textContent.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    let identifier = base;
    for (let suffix = 1; used.has(identifier); suffix++) identifier = base + "-" + suffix;
    heading.id = identifier;
    heading.setAttribute("data-doc-heading", "");
    used.add(identifier);
    return identifier;
  }

  function indexGuides() {
    if (guidePromise) return guidePromise;
    guidePromise = Promise.all(guideLinks.map(async anchor => {
      try {
        const response = await fetch(anchor.href);
        if (!response.ok) return [];
        const page = new DOMParser().parseFromString(await response.text(), "text/html");
        const prose = page.querySelector(".docs-prose");
        if (!prose) return [];
        const pageEntry = docEntries.find(entry => entry.href === anchor.href);
        pageEntry.searchText = prose.textContent;
        const used = new Set([...page.querySelectorAll("[id]")].map(node => node.id));
        return [...prose.querySelectorAll("h2, h3")].map(heading => {
          const identifier = anchorFor(heading, used);
          let text = "";
          for (let sibling = heading.nextElementSibling; sibling &&
              !/^H[23]$/.test(sibling.tagName); sibling = sibling.nextElementSibling) {
            text += " " + sibling.textContent;
          }
          text = text.replace(/\s+/g, " ").trim();
          return { title: heading.textContent + " · " + anchor.textContent,
            href: anchor.href + "#" + identifier, description: text.slice(0, 160),
            searchText: text, kind: "Guide" };
        });
      } catch { return []; }
    })).then(pages => {
      docEntries.push(...pages.flat());
      if (searchDialog.open) renderSearch();
    });
    return guidePromise;
  }

  function buildSymbolTree(roots) {
    function branch(symbol, top = false) {
      const item = element("li");
      const anchor = link(symbol.name, symbol.href, "docs-symbol-link");
      anchor.dataset.symbol = symbol.path;
      anchor.prepend(icon("file"));
      if (symbol.children.length) {
        const details = element("details", "docs-symbol-branch");
        details.open = top;
        const summary = element("summary");
        summary.append(icon("chevron-right"), anchor);
        const children = element("ul");
        children.append(...symbol.children.map(child => branch(child)));
        details.append(summary, children);
        item.append(details);
      } else item.append(anchor);
      return item;
    }
    const tree = element("ul", "docs-symbol-tree");
    tree.append(...roots.map(symbol => branch(symbol, true)));
    const navigation = element("nav");
    navigation.setAttribute("aria-label", "Public API symbols");
    navigation.append(tree);
    shell.querySelector("[data-api-tree]").replaceChildren(navigation);
    syncTree();
  }
  function syncTree() {
    const path = location.hash.slice(1).split("?")[0] || apiIndex?.roots[0]?.path;
    for (const anchor of sidebar.querySelectorAll("[data-symbol]")) {
      const active = anchor.dataset.symbol === path;
      if (active) {
        anchor.setAttribute("aria-current", "page");
        let details = anchor.closest("details");
        while (details) {
          details.open = true;
          details = details.parentElement.closest("details");
        }
      } else anchor.removeAttribute("aria-current");
    }
  }

  function setSearchSelection() {
    for (const [index, item] of [...resultList.children].entries()) {
      item.setAttribute("aria-selected", String(index === selection));
    }
    if (results.length) {
      queryInput.setAttribute("aria-activedescendant", "docs-result-" + selection);
      resultList.children[selection]?.scrollIntoView({ block: "nearest" });
    } else queryInput.removeAttribute("aria-activedescendant");
  }
  function renderSearch() {
    results = searchEntries([...docEntries, ...apiEntries], queryInput.value);
    selection = 0;
    resultList.replaceChildren(...results.map((entry, index) => {
      const item = element("li");
      item.id = "docs-result-" + index;
      item.setAttribute("role", "option");
      const anchor = link("", entry.href);
      anchor.tabIndex = -1;
      anchor.append(element("span", "docs-result-kind", entry.kind),
        element("span", "docs-result-title", entry.title),
        element("small", "docs-result-description", entry.description));
      item.append(anchor);
      item.addEventListener("pointermove", () => { selection = index; setSearchSelection(); });
      return item;
    }));
    searchStatus.textContent = !results.length ? "No results. Try a type, method, or example name."
      : queryInput.value.trim() ? results.length + " results" : "Guides and examples";
    if (!apiIndex) searchStatus.textContent += apiFailure
      ? " · API symbols unavailable. Guide search is still available."
      : " · Loading API symbols…";
    setSearchSelection();
  }
  function openSearch() {
    if (searchDialog.open) return;
    renderSearch();
    searchDialog.showModal();
    queryInput.focus();
    ensureIndex();
    indexGuides();
  }
  trigger.querySelector("kbd").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";
  trigger.addEventListener("click", openSearch);
  shell.querySelector("[data-search-close]").addEventListener("click", () => searchDialog.close());
  queryInput.addEventListener("input", renderSearch);
  queryInput.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      selection = results.length ? (selection + (event.key === "ArrowDown" ? 1 : -1)
        + results.length) % results.length : 0;
      setSearchSelection();
    } else if (event.key === "Enter" && results.length) {
      event.preventDefault();
      resultList.children[selection].querySelector("a").click();
    }
  });
  resultList.addEventListener("click", event => {
    if (event.target.closest("a")) searchDialog.close();
  });
  document.addEventListener("keydown", event => {
    const editable = event.target.closest("input, textarea, select, [contenteditable='true']");
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopImmediatePropagation();
      openSearch();
    } else if (isApi && !editable && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "s") {
      event.preventDefault();
      event.stopImmediatePropagation();
      openSearch();
    }
  }, true);
  document.addEventListener("keydown", event => {
    // Let the focused input handle arrows/Enter before stopping the compiler's
    // window-level single-letter shortcuts from consuming dialog input.
    if (isApi && (searchDialog.open || menu.open ||
        event.target.closest("input, textarea, select, [contenteditable='true']"))) {
      event.stopPropagation();
    }
  });

  menuButton.addEventListener("click", () => {
    menu.append(sidebar);
    menuButton.setAttribute("aria-expanded", "true");
    menu.showModal();
  });
  function closeMenu() { menu.close(); }
  menu.addEventListener("close", () => {
    shell.querySelector(".docs-grid").prepend(sidebar);
    menuButton.setAttribute("aria-expanded", "false");
  });
  shell.querySelector("[data-menu-close]").addEventListener("click", closeMenu);
  sidebar.addEventListener("click", event => {
    if (menu.open && event.target.closest("a")) closeMenu();
  });
  matchMedia("(min-width: 901px)").addEventListener("change", event => {
    if (event.matches && menu.open) closeMenu();
  });
  for (const dialog of [menu, searchDialog]) {
    dialog.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        dialog.close();
      }
    });
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right ||
          event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    });
  }

  function sectionHref(identifier) {
    if (!isApi) return "#" + identifier;
    const url = new URL(location.href);
    url.searchParams.set("section", identifier);
    return url.href;
  }
  function updateToc() {
    // Reassign our generated anchors deterministically after each compiler render.
    // Hidden sections must not retain IDs that collide with newly rendered docs.
    for (const heading of main.querySelectorAll("[data-doc-heading]")) {
      heading.removeAttribute("id");
      heading.removeAttribute("data-doc-heading");
    }
    const headings = [...main.querySelectorAll("h2, h3")].filter(heading =>
      !heading.closest(".hidden, [hidden], .docs-aside, .docs-reading-options") &&
      heading.textContent.trim());
    const used = new Set([...document.querySelectorAll("[id]")].map(node => node.id));
    for (const heading of headings) {
      heading.dataset.docTarget = anchorFor(heading, used);
    }
    function anchors() {
      return headings.filter(heading => !shell.classList.contains("docs-has-companion") ||
        !compiler.contains(heading)).map(heading => {
        const anchor = link(heading.textContent, sectionHref(heading.dataset.docTarget), "docs-toc-link");
        anchor.dataset.scrollTo = heading.dataset.docTarget;
        if (heading.tagName === "H3") anchor.classList.add("docs-toc-subsection");
        return anchor;
      });
    }
    shell.querySelector("[data-toc]").replaceChildren(...anchors());
    shell.querySelector("[data-inline-toc]").replaceChildren(...anchors());
    sectionObserver?.disconnect();
    const active = identifier => {
      for (const anchor of shell.querySelectorAll("[data-scroll-to]")) {
        if (anchor.dataset.scrollTo === identifier) anchor.setAttribute("aria-current", "location");
        else anchor.removeAttribute("aria-current");
      }
    };
    if (headings.length) active(headings[0].dataset.docTarget);
    sectionObserver = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
      if (visible.length) active(visible[0].target.dataset.docTarget);
    }, { rootMargin: "-100px 0px -55% 0px" });
    headings.forEach(heading => sectionObserver.observe(heading));
    const requested = new URL(location.href).searchParams.get("section");
    if (isApi && requested && lastSectionNavigation !== location.href &&
        headings.some(heading => heading.dataset.docTarget === requested)) {
      lastSectionNavigation = location.href;
      document.getElementById(requested).scrollIntoView();
    }
  }
  shell.addEventListener("click", event => {
    const anchor = event.target.closest("[data-scroll-to]");
    if (!anchor || !isApi || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.replaceState(history.state, "", anchor.href);
    lastSectionNavigation = location.href;
    document.getElementById(anchor.dataset.scrollTo)?.scrollIntoView({ behavior: "smooth" });
  });

  function copyButton(code) {
    const button = element("button", "docs-copy", "Copy");
    button.type = "button";
    button.prepend(icon("copy"));
    button.setAttribute("aria-label", "Copy " + (code.dataset.label || "code"));
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.lastChild.textContent = "Copied";
        button.setAttribute("aria-label", "Code copied");
        setTimeout(() => {
          button.lastChild.textContent = "Copy";
          button.setAttribute("aria-label", "Copy " + (code.dataset.label || "code"));
        }, 1800);
      } catch {
        const toast = document.getElementById("toast");
        toast.textContent = "Clipboard unavailable. Select the code to copy it.";
        toast.hidden = false;
        setTimeout(() => { toast.hidden = true; }, 3500);
      }
    });
    return button;
  }
  function codePane(title, source, caption) {
    const pane = element("section", "docs-code-pane");
    const code = element("code");
    code.dataset.label = title;
    code.innerHTML = highlightZig(source.trimEnd());
    const header = element("div", "docs-code-header");
    header.append(element("span", "", title), copyButton(code));
    const pre = element("pre");
    pre.append(code);
    pane.append(header);
    if (caption) pane.append(element("p", "docs-code-caption", caption));
    pane.append(pre);
    return pane;
  }
  function renderCompanion(path) {
    if (path === companionPath) return;
    companionPath = path;
    const target = shell.querySelector("[data-api-companion]");
    const companion = companionFor(path);
    const entry = companion && catalog.find(candidate => candidate.id === companion.id);
    target.hidden = !entry;
    shell.querySelector("[data-api-intro]").hidden = Boolean(entry);
    shell.classList.toggle("docs-has-companion", Boolean(entry));
    if (!entry) { target.replaceChildren(); return; }
    const header = element("header", "docs-companion-intro");
    const copy = element("div");
    copy.append(element("h1", "", companion.title),
      element("p", "", entry.id === "enum"
        ? "Describe the enum, then emit its named declaration." : "Describe the construct, then emit its named declaration."),
      element("code", "docs-qualified-name", path.replace(/^zast\./, "")));
    const playground = link("Open in playground", new URL("examples/?example=" + entry.id, root), "primary-link");
    header.append(copy, playground);
    const build = element("section");
    build.id = "doc-build";
    const heading = element("h2", "visually-hidden", "Builder and output");
    heading.id = "doc-builder-output";
    const paired = element("div", "docs-code-pair");
    paired.append(codePane("Zig builder", entry.body.replace(/\boutput_name\b/g, JSON.stringify(entry.name)), "Emission excerpt"),
      codePane("Generated Zig", entry.expected));
    const setup = element("p", "docs-example-setup");
    setup.append("The excerpt uses an initialized context pointer. Complete setup in ",
      link("Your first declaration", new URL("docs/getting-started/", root)), ".");
    build.append(heading, paired, setup);
    target.replaceChildren(header, build);
    if (entry.id === "enum") {
      const change = element("section", "docs-explanation");
      change.append(element("h2", "", "Change one property"));
      change.firstChild.id = "doc-change-property";
      const table = element("table", "docs-property-table");
      const caption = element("caption", "visually-hidden", "Backing type and generated enum syntax");
      const head = element("thead", "visually-hidden");
      const row = element("tr");
      row.append(element("th", "", "Description"), element("th", "", "Generated Zig"));
      head.append(row);
      const body = element("tbody");
      for (const [input, output] of [[".backing_type = null", "enum { … }"],
        ['.backing_type = "u8"', "enum(u8) { … }"]]) {
        const row = element("tr");
        for (const source of [input, output]) {
          const cell = element("td");
          const code = element("code");
          code.innerHTML = highlightZig(source);
          cell.append(code);
          row.append(cell);
        }
        body.append(row);
      }
      table.append(caption, head, body);
      change.append(table);
      target.append(change);
    }
    const ownership = element("section", "docs-explanation");
    ownership.append(element("h2", "", "Ownership"));
    ownership.firstChild.id = "doc-ownership";
    const note = element("p");
    note.append("Keep borrowed names, field slices, and recursive expressions alive until emission finishes. ",
      link("AstContext cleanup example", new URL("docs/getting-started/#follow-the-lifecycle", root)), ".");
    ownership.append(note);
    const related = element("p", "docs-related-methods");
    related.append("Related methods: ");
    const parent = path.slice(0, -5);
    const methods = apiIndex.symbols.find(symbol => symbol.path === parent).children
      .filter(symbol => symbol.path !== path && (symbol.category === 3 || symbol.category === 10));
    methods.forEach((symbol, index) => {
      if (index) related.append(" · ");
      related.append(link(symbol.name, symbol.href));
    });
    target.append(ownership, related, element("h2", "docs-api-details-title", "API details"));
    target.lastChild.id = "doc-api-details";
  }

  function updateApi() {
    if (!viewerReady()) return;
    if (!apiIndex) finishIndex(createApiIndex(window.wasm.instance.exports));
    syncTree();
    const rootPath = apiIndex.roots[0]?.path || "zast";
    const path = location.hash.slice(1).split("?")[0] || rootPath;
    const sourceMode = path.startsWith("src/");
    const searching = location.hash.includes("?");
    const status = compiler.querySelector("#status");
    const unresolved = !status.classList.contains("hidden");
    renderCompanion(sourceMode || searching || unresolved ? "" : path);
    const crumbs = shell.querySelector("[data-breadcrumbs]");
    crumbs.replaceChildren(link("API Reference", apiUrl));
    const parts = sourceMode ? ["Source", path.slice(4)] : searching ? ["Search results"] : path.split(".");
    parts.forEach((part, index) => {
      const separator = element("span", "", "/");
      separator.setAttribute("aria-hidden", "true");
      crumbs.append(separator, sourceMode || index === parts.length - 1 ? element("span", "", part)
        : link(part, "#" + parts.slice(0, index + 1).join(".")));
    });
    shell.querySelector("[data-api-title]").textContent = unresolved ? status.textContent
      : sourceMode ? "Source: " + parts.at(-1)
      : searching ? "Search results" : path === rootPath ? "Library reference" : parts.at(-1);
    shell.querySelector("[data-api-description]").textContent = sourceMode
      ? "Library source with compiler symbol links and line numbers."
      : "Public declarations, ownership contracts, and source from the library.";
    const source = compiler.querySelector("#hdrName > a");
    const sourceLink = shell.querySelector("[data-source]");
    sourceLink.href = unresolved ? "#src/zast/root.zig" : sourceMode ? location.href
      : source?.getAttribute("href") || "#src/zast/root.zig";
    const sourceName = path.split("/").at(-1).replace(/\.zig$/, "");
    const parent = unresolved ? rootPath : sourceMode ? apiIndex.roots[0]?.children.find(symbol =>
      symbol.name === sourceName)?.path || rootPath
      : path.includes(".") ? path.replace(/\.[^.]+$/, "") : "zast.AstContext";
    const related = shell.querySelector("[data-related]");
    related.replaceChildren(...[...new Set([parent, "zast.AstContext"])].map(path =>
      link(path.replace(/^zast\./, ""), "#" + path)));
    updateToc();
  }

  if (isApi) {
    // Observe the generated DOM as a progressive enhancement. The compiler's
    // renderer, source links, signatures, hash router and search remain intact.
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = null; updateApi(); });
    });
    observer.observe(compiler, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    window.addEventListener("hashchange", () => {
      const url = new URL(location.href);
      if (url.searchParams.has("section")) {
        url.searchParams.delete("section");
        history.replaceState(history.state, "", url.href);
      }
      requestAnimationFrame(updateApi);
    });
    window.addEventListener("popstate", () => requestAnimationFrame(updateApi));
    updateApi();
  } else {
    updateToc();
    // Current guide sections continue the same connected-tree navigation.
    const current = guideLinks.find(anchor => anchor.getAttribute("aria-current") === "page");
    if (current) {
      const sections = element("ul", "docs-guide-sections");
      sections.append(...[...article.querySelectorAll("h2")].map(heading => {
        const item = element("li");
        item.append(link(heading.textContent, "#" + heading.dataset.docTarget));
        return item;
      }));
      current.parentElement.append(sections);
    }
    const pageIndex = guideLinks.indexOf(current);
    const pagination = shell.querySelector("[data-pagination]");
    for (const [index, label] of [[pageIndex - 1, "Previous"], [pageIndex + 1, "Next"]]) {
      if (!guideLinks[index]) continue;
      const anchor = link("", guideLinks[index].href);
      anchor.append(element("small", "", label), element("span", "", guideLinks[index].textContent));
      if (label === "Next") anchor.classList.add("docs-pagination-next");
      pagination.append(anchor);
    }
    const filename = pageIndex === 0 ? "index.smd" : pageIndex === 1 ? "getting-started.smd" : "";
    shell.querySelector("[data-source]").href = filename
      ? "https://github.com/neudinger/zast-site/blob/main/content/docs/" + filename
      : "https://github.com/neudinger/zast-site/blob/main/tools/catalog.zig";
    for (const pre of article.querySelectorAll("pre")) {
      const code = pre.querySelector("code");
      if (!code) continue;
      const wrapper = element("div", "docs-code-block");
      pre.before(wrapper);
      wrapper.append(copyButton(code), pre);
    }
  }
  shell.classList.add("docs-enhanced");
}
