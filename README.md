# queueflow-docs

Source for [docs.queueflow.dev](https://docs.queueflow.dev). A dependency-light static site: Markdown in `content/**/*.md` plus the OpenAPI document in `spec/openapi.json`, rendered by `scripts/build.mjs` into `dist/`.

## Commands

```bash
npm install
npm run build       # content + spec -> dist/
npm run dev         # build, then serve dist/ locally
npm run sync-spec   # refresh spec/openapi.json from the engine checkout
npm run sync-changelog   # refresh content/changelog.md from the engine checkout
```

## Keeping the API reference current

The REST API reference (`/api`) and `dist/openapi.json` are generated from `spec/openapi.json`, which is a committed copy of the spec the engine emits. It does not update itself. After any API change in `queueflow-core`:

1. In the engine checkout, regenerate the spec: `cargo run -p queueflow -- spec` writes `spec/openapi.json` there.
2. Here, run `npm run sync-spec`. It copies `../queueflow-core-rs/spec/openapi.json` into `spec/openapi.json` and fails with an explanatory message if that sibling checkout is missing (the engine repository must be checked out next to this one under the directory name `queueflow-core-rs`).
3. Run `npm run build` and commit the updated `spec/openapi.json` together with any content changes.

`npm run build` never reads the sibling checkout; it only uses the committed `spec/openapi.json`, so a build is reproducible from this repository alone.

## Keeping the changelog current

`/changelog` is rendered from `content/changelog.md`, which is a committed copy of the engine's `CHANGELOG.md` with front matter prepended and the source's H1 dropped. After a release, run `npm run sync-changelog` (it fails with an explanatory message if `../queueflow-core-rs/CHANGELOG.md` is missing) and commit the result. Do not edit `content/changelog.md` by hand; edit the engine's changelog instead.

## Social card

`public/og.png` (1200x630) is referenced by the `og:image` and `twitter:image` tags on every page. It is rendered from `public/og.svg`; regenerate it with `npx --yes @resvg/resvg-js-cli --fit-width 1200 public/og.svg public/og.png` after editing the SVG.

## Content conventions

- Every page is `content/<slug>.md` with a front matter block (`title`, `description`) and must be listed in `scripts/nav.mjs`; the build fails on a nav entry with no page.
- Callouts are blockquotes whose first line is `**Note**`, `**Tip**`, or `**Warning**`.
- Internal links are root-relative (`/concepts/auth#development-mode`).
