/**
 * Policy format (feff.json):
 *
 * {
 *   "ignore": ["node_modules", "dist"],
 *   "rules": [
 *     { "match": ["*.json", "*.js", "*.mjs", "*.ts"], "encoding": "utf-8", "bom": "forbid" },
 *     { "match": ["*.csv"], "encoding": "utf-8", "bom": "require" },
 *     { "match": ["*.ps1"], "encoding": "utf-8", "bom": "allow" }
 *   ]
 * }
 *
 * bom: "forbid" | "require" | "allow"
 * encoding: "utf-8" — the only value feff enforces. A file in any other
 * encoding fails every rule, because the policy is about text Node will read.
 *
 * The first matching rule wins. Files matched by no rule are not checked.
 */

import { minimatch } from "./match.js";

export const DEFAULT_IGNORE = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  "coverage/**",
  "*.min.js",
];

export const DEFAULT_RULES = [
  { match: ["*.json", "*.jsonc", "*.json5"], encoding: "utf-8", bom: "forbid" },
  { match: ["*.js", "*.mjs", "*.cjs", "*.ts", "*.mts", "*.cts", "*.tsx", "*.jsx"], encoding: "utf-8", bom: "forbid" },
  { match: ["*.md", "*.yml", "*.yaml", "*.toml"], encoding: "utf-8", bom: "forbid" },
  { match: ["*.ps1", "*.psm1"], encoding: "utf-8", bom: "allow" },
  { match: ["*.csv"], encoding: "utf-8", bom: "require" },
];

const BOM_POLICIES = new Set(["forbid", "require", "allow"]);

export function validatePolicy(policy) {
  const errors = [];
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return ["policy must be an object"];
  }
  if (policy.ignore !== undefined && !isStringArray(policy.ignore)) {
    errors.push('"ignore" must be an array of glob strings');
  }
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    errors.push('"rules" must be a non-empty array');
    return errors;
  }
  policy.rules.forEach((rule, i) => {
    const where = `rules[${i}]`;
    if (rule === null || typeof rule !== "object") {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!isStringArray(rule.match) || rule.match.length === 0) {
      errors.push(`${where}.match must be a non-empty array of globs`);
    }
    if (rule.encoding !== "utf-8") {
      errors.push(`${where}.encoding must be "utf-8" (feff only judges text it can decode)`);
    }
    if (!BOM_POLICIES.has(rule.bom)) {
      errors.push(`${where}.bom must be "forbid", "require", or "allow"`);
    }
  });
  return errors;
}

export function normalizePolicy(policy) {
  return {
    ignore: [...DEFAULT_IGNORE, ...(policy.ignore ?? [])],
    rules: policy.rules.map((rule) => ({
      match: rule.match,
      encoding: rule.encoding,
      bom: rule.bom,
    })),
  };
}

/** @returns {boolean} whether the relative path is excluded from checking */
export function isIgnored(relPath, ignore) {
  const posix = toPosix(relPath);
  return ignore.some((glob) => coveredBy(posix, glob));
}

/**
 * A directory ignore covers everything inside it. `dist` and `dist/**` both
 * exclude `dist/app.js`, so a policy author does not have to remember the
 * trailing slash. A file ignore matches that one path only.
 */
function coveredBy(posix, glob) {
  if (minimatch(posix, glob)) return true;
  const dir = glob.endsWith("/**") ? glob.slice(0, -3) : glob;
  if (dir !== glob && (posix === dir || posix.startsWith(`${dir}/`))) return true;
  if (!dir.includes("*") && !dir.includes("?") && posix.startsWith(`${dir}/`)) return true;
  return false;
}

/** @returns {object|null} the first rule whose match hits the path */
export function matchRule(relPath, rules) {
  const posix = toPosix(relPath);
  const base = posix.split("/").pop();
  for (const rule of rules) {
    if (rule.match.some((glob) => minimatch(base, glob) || minimatch(posix, glob))) return rule;
  }
  return null;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function toPosix(p) {
  return p.replaceAll("\\", "/");
}
