import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isIgnored } from "./policy.js";

const SKIP_DIRS = new Set([".git", "node_modules"]);

const MAX_BYTES = 32 * 1024 * 1024;

/**
 * Walk a directory and read every regular file up to 32 MiB. Anything larger
 * is reported as skipped instead of being loaded, so one data dump cannot
 * exhaust memory. Directories that can never be useful to check are skipped
 * before descent.
 *
 * @param {string[]} ignore directories matched by these globs are not descended into
 * @returns {Promise<{files: {path: string, bytes: Uint8Array}[], skipped: {path: string, bytes: number}[]}>}
 */
export async function readTree(root, ignore = []) {
  const files = [];
  const skipped = [];
  await descend(root, "", files, skipped, ignore);
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  files.sort(byPath);
  skipped.sort(byPath);
  return { files, skipped };
}

async function descend(dir, rel, files, skipped, ignore) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const child = joinRel(rel, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || isIgnored(child, ignore)) continue;
      await descend(path.join(dir, entry.name), child, files, skipped, ignore);
    } else if (entry.isFile()) {
      const abs = path.join(dir, entry.name);
      const size = (await stat(abs)).size;
      if (size > MAX_BYTES) {
        skipped.push({ path: child, bytes: size });
        continue;
      }
      files.push({ path: child, bytes: new Uint8Array(await readFile(abs)) });
    }
  }
}

function joinRel(dir, name) {
  return dir ? `${dir}/${name}` : name;
}
