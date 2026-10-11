/**
 * Rewriting a file to satisfy its rule. The only rewrite feff will do is
 * add or remove a UTF-8 BOM; it never transcodes, because guessing the
 * source encoding is how files get silently destroyed.
 */

import { inspectBytes } from "./bom.js";

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

/**
 * @returns {{changed: boolean, reason?: string, bytes?: Uint8Array}}
 * `changed: false` with a reason means "I will not touch this file".
 */
export function fixBytes(buffer, rule) {
  const inspection = inspectBytes(buffer);
  if (inspection.kind === "binary" || inspection.kind === "corrupt") {
    return { changed: false, reason: "refusing to rewrite a file that is not valid text" };
  }
  if (inspection.kind === "bom" && inspection.encoding !== "utf-8") {
    return { changed: false, reason: `refusing to transcode ${inspection.encoding}; convert it to UTF-8 yourself first` };
  }

  const hasBom = inspection.kind === "bom";
  if (rule.bom === "allow" || (rule.bom === "forbid" && !hasBom) || (rule.bom === "require" && hasBom)) {
    return { changed: false };
  }

  const body = inspection.body;
  if (rule.bom === "forbid") return { changed: true, bytes: Uint8Array.from(body) };
  const out = new Uint8Array(UTF8_BOM.length + body.length);
  out.set(UTF8_BOM, 0);
  out.set(body, UTF8_BOM.length);
  return { changed: true, bytes: out };
}
