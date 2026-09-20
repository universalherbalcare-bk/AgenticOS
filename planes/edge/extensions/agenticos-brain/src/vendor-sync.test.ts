// Fails the build if vendor/*.ts drifts from the canonical bridge/ts/src files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HEADER_SENTINEL,
  SOURCE_DIR,
  VENDOR_DIR,
  VENDORED_FILES,
  stripVendorHeader,
  vendorHeader,
} from "../vendor/sync.mts";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("vendored bridge files", () => {
  it("resolves the canonical bridge sources from this extension", () => {
    expect(path.resolve(here, "../vendor")).toBe(VENDOR_DIR);
    expect(fs.existsSync(SOURCE_DIR), `missing canonical bridge dir ${SOURCE_DIR}`).toBe(true);
    for (const fileName of VENDORED_FILES) {
      expect(fs.existsSync(path.join(SOURCE_DIR, fileName)), `missing ${fileName}`).toBe(true);
    }
  });

  it.each(VENDORED_FILES)(
    "vendor/%s is byte-identical to bridge/ts/src after the header",
    (fileName) => {
      const vendoredPath = path.join(VENDOR_DIR, fileName);
      const sourcePath = path.join(SOURCE_DIR, fileName);
      const vendored = fs.readFileSync(vendoredPath, "utf8");
      const source = fs.readFileSync(sourcePath);

      expect(vendored.startsWith(vendorHeader(fileName)), `${fileName} header changed`).toBe(true);
      const body = stripVendorHeader(vendored);
      expect(body, `${fileName} is missing the sentinel "${HEADER_SENTINEL}"`).not.toBeNull();
      expect(
        Buffer.from(body as string, "utf8").equals(source),
        `vendor/${fileName} drifted from bridge/ts/src/${fileName}; run: node extensions/agenticos-brain/vendor/sync.mts`,
      ).toBe(true);
    },
  );

  it("vendored client imports the vendored contract, not the canonical one", () => {
    const client = fs.readFileSync(path.join(VENDOR_DIR, "client.ts"), "utf8");
    const body = stripVendorHeader(client) ?? "";
    expect(body).toContain('from "./contract.ts"');
    expect(body).not.toContain("bridge/ts/src");
  });
});
