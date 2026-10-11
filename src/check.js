/**
 * The check itself. Pure: it takes bytes plus a policy and returns findings.
 * Finding out which files exist is the caller's job, so this module is
 * testable without a filesystem.
 */

import { inspectBytes } from "./bom.js";
import { isIgnored, matchRule } from "./policy.js";

/**
 * @param {{path: string, bytes: Uint8Array}[]} files paths relative to the root
 * @param {{ignore: string[], rules: object[]}} policy already normalized
 * @returns {{path: string, rule: string, severity: "error", message: string}[]}
 */
export function checkFiles(files, policy) {
  const findings = [];
  for (const file of files) {
    if (isIgnored(file.path, policy.ignore)) continue;
    const rule = matchRule(file.path, policy.rules);
    if (!rule) continue;
    const inspection = inspectBytes(file.bytes);
    const finding = judge(file.path, rule, inspection);
    if (finding) findings.push(finding);
  }
  return findings;
}

function judge(path, rule, inspection) {
  const label = `${rule.match.join(",")} → ${rule.encoding}, bom ${rule.bom}`;

  if (inspection.kind === "binary") {
    return error(path, label, "file is not valid UTF-8 (and has no BOM). If it is binary, remove it from the rule's match.");
  }
  if (inspection.kind === "corrupt") {
    return error(path, label, `file starts with a ${inspection.encoding} BOM but the rest is not valid ${inspection.encoding}`);
  }
  if (inspection.kind === "bom" && inspection.encoding !== "utf-8") {
    return error(
      path,
      label,
      `file is ${inspection.encoding}; the rule requires utf-8. Node reads this as mojibake, not as text.`,
    );
  }

  const hasBom = inspection.kind === "bom";
  if (rule.bom === "forbid" && hasBom) {
    return error(
      path,
      label,
      "UTF-8 BOM (EF BB BF) present. JSON.parse, many bundlers and Node's utf8 reads keep the U+FEFF, so the file parses as if it had an invisible first character.",
    );
  }
  if (rule.bom === "require" && !hasBom) {
    return error(
      path,
      label,
      "UTF-8 BOM required but absent. Excel on Windows guesses the encoding of a BOM-less CSV and will misread non-ASCII.",
    );
  }
  return null;
}

function error(path, rule, message) {
  return { path, rule, severity: "error", message };
}

/**
 * Explain the one failure people hit without knowing why: a JSON file whose
 * first character is U+FEFF. Returns null when the text is not JSON-shaped
 * or parses cleanly.
 */
export function explainJson(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    const head = text.codePointAt(0);
    if (head === 0xfeff) {
      return `JSON.parse fails because the first character is U+FEFF, left behind by a UTF-8 BOM: ${err.message}`;
    }
    return null;
  }
}
