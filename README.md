# zast site

Presentation website and documentation for [zast](https://github.com/neudinger/zast).
Built with Zine, SuperMD, and shared SuperHTML layouts.
The example catalogue is generated from the pinned Zast guide.

## Requirements

- **Zig 0.17.0** for the build.
- **Node.js 22 or newer** for tests.

Zig fetches Zast and Zine at the revisions pinned in [build.zig.zon](build.zig.zon).

## Build

~~~sh
zig build
zig build test
zig build sync-examples
zig build catalog
~~~

The site is written to `dist/` with the `/zast-site/` deployment prefix.

Edit the SuperMD pages in [content/](content/) and shared templates in
[layouts/](layouts/).

The build regenerates `assets/catalog.js`, `content/docs/examples.smd`,
`wasm/GuideExamples.zig`, and `wasm/guide-catalog.json`.

## License

[EUPL-1.2](LICENSE).
