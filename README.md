# queueflow-docs

Source for [docs.queueflow.dev](https://docs.queueflow.dev). A dependency-light static site: Markdown in `content/**/*.md` plus the OpenAPI document in `spec/openapi.json`, rendered by `scripts/build.mjs` into `dist/`.

## Commands

```bash
npm install
npm run build       # content + spec -> dist/
npm run dev         # build, then serve dist/ locally
npm run sync-spec   # refresh spec/openapi.json from the engine checkout
```

## Keeping the API reference current

The REST API reference (`/api`) and `dist/openapi.json` are generated from `spec/openapi.json`, which is a committed copy of the spec the engine emits. It does not update itself. After any API change in `queueflow-core`:

1. In the engine checkout, regenerate the spec: `cargo run -p queueflow -- spec` writes `spec/openapi.json` there.
2. Here, run `npm run sync-spec`. It copies `../queueflow-core-rs/spec/openapi.json` into `spec/openapi.json` and fails with an explanatory message if that sibling checkout is missing (the engine repository must be checked out next to this one under the directory name `queueflow-core-rs`).
3. Run `npm run build` and commit the updated `spec/openapi.json` together with any content changes.

`npm run build` never reads the sibling checkout; it only uses the committed `spec/openapi.json`, so a build is reproducible from this repository alone.

## Content conventions

- Every page is `content/<slug>.md` with a front matter block (`title`, `description`) and must be listed in `scripts/nav.mjs`; the build fails on a nav entry with no page.
- Callouts are blockquotes whose first line is `**Note**`, `**Tip**`, or `**Warning**`.
- Internal links are root-relative (`/concepts/auth#development-mode`).
