import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { inspectBytes } from "./bom.js";
import { DEFAULT_RULES, normalizePolicy, validatePolicy } from "./policy.js";

export const CONFIG_NAME = "feff.json";

/**
 * The directory whose feff.json governs `start`. Walks up from a file's own
 * directory. When nothing is found, returns that directory so the caller can
 * fall back to the default policy.
 */
export async function findConfigRoot(start) {
  let dir = start;
  try {
    if ((await stat(start)).isFile()) dir = path.dirname(start);
  } catch {
    dir = path.dirname(start);
  }
  for (;;) {
    try {
      if ((await stat(path.join(dir, CONFIG_NAME))).isFile()) return dir;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

/** Load feff.json from root, or build the default policy when it is absent. */
export async function loadPolicy(root) {
  let raw;
  try {
    raw = await readFile(path.join(root, CONFIG_NAME));
  } catch (err) {
    if (err.code === "ENOENT") return { policy: normalizePolicy({ rules: DEFAULT_RULES }), source: "default" };
    throw err;
  }
  const inspection = inspectBytes(raw);
  if (inspection.kind !== "utf-8" && !(inspection.kind === "bom" && inspection.encoding === "utf-8")) {
    return { error: `${CONFIG_NAME} must be UTF-8. feff will not guess the encoding of its own policy.` };
  }
  let parsed;
  try {
    parsed = JSON.parse(inspection.text);
  } catch (err) {
    return { error: `${CONFIG_NAME} is not valid JSON: ${err.message}` };
  }
  const problems = validatePolicy(parsed);
  if (problems.length > 0) return { error: problems.map((p) => `${CONFIG_NAME}: ${p}`).join("\n") };
  return { policy: normalizePolicy(parsed), source: CONFIG_NAME };
}
