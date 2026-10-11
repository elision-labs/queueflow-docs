// Copy the engine's CHANGELOG.md into content/changelog.md with front matter.
//
// Like sync-spec, this reads the sibling checkout ../queueflow-core-rs and
// fails loudly when it is missing. `npm run build` never runs this; it only
// renders the committed content/changelog.md.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "..", "queueflow-core-rs", "CHANGELOG.md");
const TARGET = join(ROOT, "content", "changelog.md");

if (!existsSync(SOURCE)) {
  console.error(
    `sync-changelog: ${SOURCE} not found. Check out queueflow-core as a sibling directory named queueflow-core-rs first.`,
  );
  process.exit(1);
}

// Drop the source's own H1; the page template renders the title.
const body = readFileSync(SOURCE, "utf8").replace(/^# Changelog[^\n]*\n+/, "");

const frontMatter = `---
title: Changelog
description: Release notes for the QueueFlow server and its Rust crates, copied from CHANGELOG.md in the engine repository. The language SDKs keep their own changelogs.
---

`;

writeFileSync(TARGET, frontMatter + body);
console.log("sync-changelog: wrote content/changelog.md");
