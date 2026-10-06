// Static site generator for docs.queueflow.dev.
//
// content/**/*.md  -> dist/**/*.html   (Markdown with a small front matter block)
// spec/openapi.json -> dist/api.html + dist/openapi.json  (API reference, generated)
// public/*          -> dist/*
//
// No framework: marked for Markdown, highlight.js for code, one HTML template.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, cpSync, rmSync, existsSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";
import hljs from "highlight.js";
import { NAV } from "./nav.mjs";
import { renderApiReference } from "./api-reference.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = join(ROOT, "content");
const DIST = join(ROOT, "dist");
const SITE = "https://docs.queueflow.dev";

// ---------------------------------------------------------------------------
// Markdown

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function makeMarked(toc) {
  const marked = new Marked();
  const seen = new Map();
  marked.use({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        let id = slugify(text);
        const n = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (depth === 2 || depth === 3) toc.push({ depth, id, text });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${text}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const language = (lang || "").split(/\s+/)[0];
        let body;
        if (language && hljs.getLanguage(language)) {
          body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        } else {
          body = escapeHtml(text);
        }
        const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : "";
        return `<div class="code">${label}<button class="copy" type="button" aria-label="Copy code">Copy</button><pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ""}">${body}</code></pre></div>\n`;
      },
      table(token) {
        const header = token.header
          .map((cell) => `<th${cell.align ? ` align="${cell.align}"` : ""}>${this.parser.parseInline(cell.tokens)}</th>`)
          .join("");
        const rows = token.rows
          .map(
            (row) =>
              `<tr>${row
                .map((cell) => `<td${cell.align ? ` align="${cell.align}"` : ""}>${this.parser.parseInline(cell.tokens)}</td>`)
                .join("")}</tr>`,
          )
          .join("\n");
        return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>\n${rows}\n</tbody></table></div>\n`;
      },
    },
  });
  // Callouts: a blockquote whose first line is **Note**, **Tip**, or **Warning**.
  marked.use({
    walkTokens(token) {
      if (token.type !== "blockquote") return;
      const first = token.tokens?.[0];
      const strong = first?.tokens?.[0];
      if (first?.type === "paragraph" && strong?.type === "strong") {
        const kind = strong.text.toLowerCase();
        if (["note", "tip", "warning"].includes(kind)) token.callout = kind;
      }
    },
    renderer: {
      blockquote({ tokens, callout }) {
        const body = this.parser.parse(tokens);
        if (!callout) return `<blockquote>${body}</blockquote>\n`;
        return `<aside class="callout callout-${callout}">${body}</aside>\n`;
      },
    },
  });
  return marked;
}

function parseFrontMatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { meta, body: src.slice(m[0].length) };
}

// ---------------------------------------------------------------------------
// Template

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#171b23"/><circle cx="9" cy="16" r="3" fill="#34d399"/><circle cx="23" cy="9" r="3" fill="#34d399"/><circle cx="23" cy="23" r="3" fill="#34d399"/><path d="M11.5 14.5 20.5 10M11.5 17.5 20.5 22" stroke="#34d399" stroke-width="2" stroke-linecap="round"/></svg>`;
const GITHUB = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

const allPages = NAV.flatMap((s) => s.pages);
const hrefFor = (slug) => (slug === "index" ? "/" : `/${slug}`);

function sidebar(current) {
  return NAV.map(
    (section) => `<div class="nav-section"><div class="nav-title">${section.title}</div><ul>${section.pages
      .map(
        (p) =>
          `<li><a href="${hrefFor(p.slug)}"${p.slug === current ? ' aria-current="page"' : ""}>${p.title}</a></li>`,
      )
      .join("")}</ul></div>`,
  ).join("");
}

function prevNext(current) {
  const i = allPages.findIndex((p) => p.slug === current);
  if (i === -1) return "";
  const prev = allPages[i - 1];
  const next = allPages[i + 1];
  return `<nav class="pager" aria-label="Previous and next page">${
    prev ? `<a class="pager-prev" href="${hrefFor(prev.slug)}"><span>Previous</span>${prev.title}</a>` : "<span></span>"
  }${next ? `<a class="pager-next" href="${hrefFor(next.slug)}"><span>Next</span>${next.title}</a>` : "<span></span>"}</nav>`;
}

function tocHtml(toc) {
  const items = toc.filter((t) => t.depth === 2 || t.depth === 3);
  if (items.length < 2) return "";
  return `<aside class="toc"><div class="toc-title">On this page</div><ul>${items
    .map((t) => `<li class="toc-${t.depth}"><a href="#${t.id}">${t.text}</a></li>`)
    .join("")}</ul></aside>`;
}

function page({ slug, title, description, html, toc, section }) {
  const url = SITE + hrefFor(slug);
  const fullTitle = slug === "index" ? "QueueFlow Docs" : `${title} · QueueFlow Docs`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(fullTitle)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<link rel="canonical" href="${url}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="top">
  <div class="top-inner">
    <button class="menu" type="button" aria-label="Toggle navigation" aria-expanded="false" aria-controls="sidebar">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    </button>
    <a class="brand" href="/">${LOGO}<span>QueueFlow</span><span class="brand-docs">Docs</span></a>
    <div class="search" role="search">
      <input id="search" type="search" placeholder="Search docs" aria-label="Search docs" autocomplete="off" spellcheck="false">
      <kbd>/</kbd>
      <div class="search-results" id="search-results" hidden></div>
    </div>
    <nav class="top-links" aria-label="Site">
      <a href="https://queueflow.dev">queueflow.dev</a>
      <a href="https://demo.queueflow.dev">Demo</a>
      <a class="gh" href="https://github.com/elision-labs/queueflow-core">${GITHUB}GitHub</a>
    </nav>
  </div>
</header>
<div class="shell">
  <nav class="sidebar" id="sidebar" aria-label="Documentation">${sidebar(slug)}</nav>
  <main class="main" id="content">
    <article class="doc">
      <p class="crumb">${escapeHtml(section)}</p>
      <h1>${title}</h1>
      <p class="lede">${escapeHtml(description)}</p>
      ${html}
      ${prevNext(slug)}
    </article>
    <footer class="foot">
      <span>&copy; 2026 QueueFlow &middot; MIT License</span>
      <a href="https://github.com/elision-labs/queueflow-core/issues">Report a docs issue</a>
    </footer>
  </main>
  ${tocHtml(toc)}
</div>
<script src="/docs.js" defer></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Build

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

const textOf = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(join(ROOT, "public"), DIST, { recursive: true });

const searchIndex = [];
const built = new Set();

function emit(slug, meta, html, toc) {
  const section = NAV.find((s) => s.pages.some((p) => p.slug === slug))?.title ?? "Docs";
  const nav = allPages.find((p) => p.slug === slug);
  const title = meta.title ?? nav?.title ?? slug;
  const description = meta.description ?? "";
  const out = join(DIST, `${slug}.html`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, page({ slug, title, description, html, toc, section }));
  built.add(slug);
  const text = textOf(html);
  searchIndex.push({
    slug,
    url: hrefFor(slug),
    title,
    section,
    description,
    headings: toc.map((t) => ({ id: t.id, text: textOf(t.text) })),
    text: text.slice(0, 20000),
  });
}

for (const file of walk(CONTENT)) {
  const slug = relative(CONTENT, file).split(sep).join("/").replace(/\.md$/, "");
  const { meta, body } = parseFrontMatter(readFileSync(file, "utf8"));
  const toc = [];
  const html = makeMarked(toc).parse(body);
  emit(slug, meta, html, toc);
}

// API reference, generated from the spec.
{
  const spec = JSON.parse(readFileSync(join(ROOT, "spec", "openapi.json"), "utf8"));
  writeFileSync(join(DIST, "openapi.json"), JSON.stringify(spec, null, 2));
  const toc = [];
  const html = renderApiReference(spec, { hljs, escapeHtml, slugify, toc, markdown: (s) => makeMarked([]).parseInline(s) });
  emit(
    "api",
    {
      title: "REST API reference",
      description: `Every endpoint and schema of the QueueFlow REST API (OpenAPI ${spec.info.version}), generated from the spec the server itself emits.`,
    },
    html,
    toc,
  );
}

for (const p of allPages) {
  if (!built.has(p.slug)) throw new Error(`nav.mjs lists "${p.slug}" but no content was built for it`);
}

writeFileSync(join(DIST, "search-index.json"), JSON.stringify(searchIndex));
writeFileSync(
  join(DIST, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...built]
    .map((s) => `  <url><loc>${SITE}${hrefFor(s)}</loc></url>`)
    .join("\n")}\n</urlset>\n`,
);
writeFileSync(join(DIST, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`built ${built.size} pages -> ${relative(ROOT, DIST)}/`);
