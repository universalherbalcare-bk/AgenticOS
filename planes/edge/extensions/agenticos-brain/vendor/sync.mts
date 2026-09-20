#!/usr/bin/env node
// Regenerates vendor/client.ts and vendor/contract.ts from bridge/ts/src.
//
// Why a copy exists at all: two repo gates reject a relative import that escapes
// the extension package (tsc TS6059 via the extension tsconfig's rootDir, and
// `lint:extensions:no-relative-outside-package`). The copy is verbatim; the
// header below is the only addition, and src/vendor-sync.test.ts fails the
// build if the bytes after the header ever differ from the originals.
//
// Runs under Node's native type stripping (erasable syntax only, no enums or
// parameter properties). Usage: node extensions/agenticos-brain/vendor/sync.mts
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const VENDOR_DIR: string = here;
export const SOURCE_DIR: string = path.resolve(here, "../../../../../bridge/ts/src");
export const VENDORED_FILES: readonly string[] = ["client.ts", "contract.ts"];
export const HEADER_SENTINEL = "// --- BEGIN VERBATIM COPY (do not edit below this line) ---";

export function vendorHeader(fileName: string): string {
  return [
    `// VERBATIM COPY of bridge/ts/src/${fileName}. DO NOT EDIT HERE.`,
    "// Canonical source: /bridge/ts/src (the AgenticOS bridge contract package).",
    "// This copy exists only because bundled OpenClaw extensions may not import",
    "// outside their own package root (tsc rootDir + lint:extensions:no-relative-outside-package).",
    "// Keep in sync with: node extensions/agenticos-brain/vendor/sync.mts",
    "// Drift is a build failure: see src/vendor-sync.test.ts.",
    HEADER_SENTINEL,
    "",
  ].join("\n");
}

export function stripVendorHeader(text: string): string | null {
  const idx = text.indexOf(`${HEADER_SENTINEL}\n`);
  if (idx === -1) {
    return null;
  }
  return text.slice(idx + HEADER_SENTINEL.length + 1);
}

export function syncVendoredFiles(): void {
  for (const fileName of VENDORED_FILES) {
    const source = readFileSync(path.join(SOURCE_DIR, fileName), "utf8");
    writeFileSync(path.join(VENDOR_DIR, fileName), vendorHeader(fileName) + source);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  syncVendoredFiles();
  for (const fileName of VENDORED_FILES) {
    console.log(`synced vendor/${fileName} from bridge/ts/src/${fileName}`);
  }
}
