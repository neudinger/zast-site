# zast site

Presentation website, documentation, blog, and interactive playground for
[zast](../zast). Built with Zine, SuperMD, and small SuperHTML layouts.
The playground runs the Zig generator locally in the browser through WebAssembly.

## Requirements

- **Zig 0.17.0**, enforced by the build and ZVM directive.
- A sibling `../zast` checkout, or set `ZAST_DIR` to another checkout containing
  `src/root.zig` and `docs/examples.md` for the site build.
- **Node.js 22 or newer** for JavaScript/Wasm tests only.

The exact Zine revision is pinned in [build.zig.zon](build.zig.zon).

## Build and preview

Run from this directory:

~~~sh
zvm run 0.17.0 build
zvm run 0.17.0 build serve
zvm run 0.17.0 build test
~~~

With Zig 0.17.0 selected, `zig build`, `zig build serve`, and `zig build test`
are equivalent. Preview at <http://127.0.0.1:1990/>; stop with Ctrl+C.
The release build validates the complete website before replacing `dist/`.

Content, layouts, CSS, and site assets reload during preview. Rebuild and restart
for changes to the library, Wasm sources, or generated example snapshots.

## Editing

| Location | Purpose |
| --- | --- |
| [content/](content/) | Authored SuperMD pages, except the generated examples page |
| [layouts/](layouts/) | Shared SuperHTML page structure |
| [assets/](assets/) | Styling, browser code, fonts, icons, and artwork |
| [wasm/](wasm/) | Browser generator and example fixtures |
| [tools/catalog.zig](tools/catalog.zig) | Catalogue entries and guide syncing |
| [tools/catalog-intro.smd](tools/catalog-intro.smd) | Introduction to the generated examples page |
| [tools/](tools/) and [build.zig](build.zig) | Site tooling and build graph |
| [tests/](tests/) | Native integration and JavaScript/Wasm checks |

Generated files: `assets/catalog.js`, `content/docs/examples.smd`,
`wasm/GuideExamples.zig`, `wasm/guide-catalog.json`, and `dist/`.

## License

[EUPL-1.2](../zast/LICENSE).
