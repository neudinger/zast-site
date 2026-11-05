# zast site

Presentation website and documentation for [zast](https://github.com/neudinger/zast).
Built with Zine, SuperMD, and shared SuperHTML layouts.

## Requirements

- **Zig 0.17.0** for the build.
- **Node.js 22 or newer** for tests.

Zig fetches Zine at the revisions pinned in [build.zig.zon](build.zig.zon).

## Build

~~~sh
zig build
zig build test
~~~

The site is written to `dist/` with the `/zast-site/` deployment prefix.

Edit the SuperMD pages in [content/](content/) and shared templates in
[layouts/](layouts/).

## License

[EUPL-1.2](LICENSE).
