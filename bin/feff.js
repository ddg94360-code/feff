#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkFiles, explainJson } from "../src/check.js";
import { findConfigRoot, loadPolicy } from "../src/config.js";
import { fixBytes } from "../src/fix.js";
import { formatFindings, formatJson } from "../src/format.js";
import { isIgnored, matchRule } from "../src/policy.js";
import { readTree } from "../src/walk.js";
import { inspectBytes } from "../src/bom.js";

const USAGE = `feff — an encoding policy for files

Usage:
  feff check [path] [--json]        report files that break the policy (default)
  feff fix [path] [--dry-run]       add or remove UTF-8 BOMs to match the policy
  feff why <file>                   explain one file: what it is, and why it fails
  feff init                         write a starter feff.json in the current directory

The policy lives in feff.json. With no feff.json, feff uses its defaults:
no BOM for source and JSON, a BOM required for CSV, PowerShell scripts exempt
in whatever encoding Windows saved them. Matching ignores case.
Exit code is 1 when any file fails, 2 when the policy itself is broken.
`;

const args = process.argv.slice(2);

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const code = await main(args);
    process.exitCode = code;
  } catch (err) {
    console.error(`feff: ${err.message}`);
    process.exitCode = 2;
  }
}

export async function run(argv) {
  return main(argv);
}

async function main(argv) {
  const [command = "check", ...rest] = argv.filter((a) => a !== "--");
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (command === "init") return init();
  if (command === "why") return why(rest[0]);
  if (command === "check" || command === "fix") return scan(command, rest);
  if (!command.startsWith("-")) return scan("check", [command, ...rest]);
  console.error(USAGE);
  return 2;
}

async function scan(command, rest) {
  const json = rest.includes("--json");
  const dryRun = rest.includes("--dry-run");
  const dirArg = rest.find((a) => !a.startsWith("--"));
  const target = path.resolve(dirArg ?? ".");
  const info = await stat(target);
  const root = info.isDirectory() ? target : await findConfigRoot(target);
  const loaded = await loadPolicy(root);
  if (loaded.error) {
    console.error(loaded.error);
    return 2;
  }

  const tree = info.isDirectory() ? await readTree(root, loaded.policy.ignore) : null;
  const files = tree
    ? tree.files
    : [{ path: path.relative(root, target).split(path.sep).join("/"), bytes: new Uint8Array(await readFile(target)) }];
  const judged = files.filter((file) => !isIgnored(file.path, loaded.policy.ignore));
  for (const big of tree?.skipped ?? []) {
    console.error(`${big.path}: skipped, ${big.bytes} bytes exceeds the 32 MiB limit`);
  }
  if (command === "check") {
    const findings = checkFiles(judged, loaded.policy);
    if (findings.length === 0) {
      console.log(`feff: ${judged.length} files checked, nothing to report (${loaded.source})`);
      return 0;
    }
    console.error(json ? formatJson(findings) : formatFindings(findings));
    console.error(`\nfeff: ${findings.length} file${findings.length === 1 ? "" : "s"} break the policy`);
    return 1;
  }

  let changed = 0;
  let refused = 0;
  for (const file of judged) {
    const rule = matchRule(file.path, loaded.policy.rules);
    if (!rule) continue;
    const result = fixBytes(file.bytes, rule);
    if (result.reason) {
      console.error(`${file.path}: ${result.reason}`);
      refused += 1;
    } else if (result.changed) {
      if (dryRun) {
        console.log(`${file.path}: would rewrite`);
      } else {
        await writeFile(path.join(root, ...file.path.split("/")), result.bytes);
        console.log(`${file.path}: rewritten`);
      }
      changed += 1;
    }
  }
  console.log(`feff: ${changed} ${dryRun ? "would be rewritten" : "rewritten"}, ${refused} left untouched`);
  return refused > 0 ? 1 : 0;
}

async function why(fileArg) {
  if (!fileArg) {
    console.error("feff why: give me a file");
    return 2;
  }
  const abs = path.resolve(fileArg);
  const bytes = new Uint8Array(await readFile(abs));
  const inspection = inspectBytes(bytes);
  const root = await findConfigRoot(abs);
  const loaded = await loadPolicy(root);
  const rel = path.relative(root, abs).split(path.sep).join("/");

  console.log(`${rel}: ${describe(inspection, bytes.length)}`);
  if (loaded.error) {
    console.error(loaded.error);
    return 2;
  }
  const rule = matchRule(rel, loaded.policy.rules);
  console.log(rule ? `rule: ${rule.match.join(", ")} → bom ${rule.bom}` : "rule: none (this file is not covered)");
  if (isIgnored(rel, loaded.policy.ignore)) {
    console.log("verdict: ignored, so neither check nor fix will touch it");
    return 0;
  }
  const findings = checkFiles([{ path: rel, bytes }], loaded.policy);
  if (findings.length === 0) {
    console.log("verdict: passes");
    return 0;
  }
  console.log(`verdict: ${findings[0].message}`);
  if (inspection.text) {
    const json = explainJson(inspection.text);
    if (json) console.log(json);
  }
  return 1;
}

function describe(inspection, size) {
  if (inspection.kind === "utf-8") return `UTF-8, no BOM (${size} bytes)`;
  if (inspection.kind === "binary") return `not valid UTF-8 and no BOM (${size} bytes)`;
  if (inspection.kind === "corrupt") return `starts with a ${inspection.encoding} BOM but is not valid ${inspection.encoding}`;
  return `${inspection.encoding} with BOM (${size} bytes, ${inspection.bomLength} byte mark)`;
}

async function init() {
  const { writeFile: write, access } = await import("node:fs/promises");
  const target = path.resolve(CONFIG_FALLBACK());
  try {
    await access(target);
    console.error(`feff init: ${target} already exists, leaving it alone`);
    return 1;
  } catch {
    // absent, good
  }
  await write(target, `${JSON.stringify(starterPolicy(), null, 2)}\n`);
  console.log(`feff: wrote ${target}`);
  return 0;
}

function CONFIG_FALLBACK() {
  return "feff.json";
}

function starterPolicy() {
  return {
    ignore: [],
    rules: [
      { match: ["*.json", "*.js", "*.mjs", "*.cjs", "*.ts", "*.md", "*.yml", "*.yaml"], encoding: "utf-8", bom: "forbid" },
      { match: ["*.ps1", "*.psm1"], encoding: "any", bom: "allow" },
      { match: ["*.csv"], encoding: "utf-8", bom: "require" },
    ],
  };
}
