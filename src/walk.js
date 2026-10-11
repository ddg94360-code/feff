import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isIgnored } from "./policy.js";

const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Walk a directory and read every regular file. Directories that can never
 * be useful to check are skipped before descent, so a huge node_modules
 * does not get read at all.
 *
 * @param {string[]} ignore directories matched by these globs are not descended into
 * @returns {Promise<{path: string, bytes: Uint8Array}[]>} paths relative, posix
 */
export async function readTree(root, ignore = []) {
  const out = [];
  await descend(root, "", out, ignore);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

async function descend(dir, rel, out, ignore) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const child = joinRel(rel, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || isIgnored(child, ignore)) continue;
      await descend(path.join(dir, entry.name), child, out, ignore);
    } else if (entry.isFile()) {
      out.push({ path: child, bytes: new Uint8Array(await readFile(path.join(dir, entry.name))) });
    }
  }
}

function joinRel(dir, name) {
  return dir ? `${dir}/${name}` : name;
}
