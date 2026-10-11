import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { detectBom, inspectBytes, isValidUtf8 } from "../src/bom.js";
import { checkFiles, explainJson } from "../src/check.js";
import { findConfigRoot, loadPolicy } from "../src/config.js";
import { fixBytes } from "../src/fix.js";
import { minimatch } from "../src/match.js";
import { isIgnored, matchRule, normalizePolicy, validatePolicy } from "../src/policy.js";
import { readTree } from "../src/walk.js";

const utf8 = (s) => new TextEncoder().encode(s);
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

function withBom(text) {
  const body = utf8(text);
  const out = new Uint8Array(BOM.length + body.length);
  out.set(BOM, 0);
  out.set(body, BOM.length);
  return out;
}

describe("BOM detection", () => {
  it("finds a UTF-8 BOM and nothing else", () => {
    assert.deepEqual(detectBom(withBom("{")), { encoding: "utf-8", length: 3 });
    assert.equal(detectBom(utf8("{")), null);
  });

  it("does not mistake a shorter prefix for a longer mark", () => {
    assert.equal(detectBom(new Uint8Array([0xff, 0xfe])).encoding, "utf-16le");
    assert.equal(detectBom(new Uint8Array([0xff, 0xfe, 0x00, 0x00])).encoding, "utf-32le");
    assert.equal(detectBom(new Uint8Array([0xff])), null);
  });

  it("rejects overlong UTF-8 and lone surrogates", () => {
    assert.equal(isValidUtf8(new Uint8Array([0xc0, 0x80])), false);
    assert.equal(isValidUtf8(new Uint8Array([0xed, 0xa0, 0x80])), false);
    assert.equal(isValidUtf8(utf8("正確")), true);
  });

  it("calls a BOM followed by broken bytes corrupt, not a clean BOM", () => {
    const broken = new Uint8Array([0xef, 0xbb, 0xbf, 0xff]);
    assert.equal(inspectBytes(broken).kind, "corrupt");
  });

  it("decodes UTF-16 LE with a BOM into the same text", () => {
    const units = Buffer.from("hi", "utf16le");
    const bytes = new Uint8Array([0xff, 0xfe, ...units]);
    const inspection = inspectBytes(bytes);
    assert.equal(inspection.kind, "bom");
    assert.equal(inspection.encoding, "utf-16le");
    assert.equal(inspection.text, "hi");
  });
});

describe("policy", () => {
  it("rejects a rule with no encoding decision", () => {
    const problems = validatePolicy({ rules: [{ match: ["*.json"], bom: "forbid" }] });
    assert.ok(problems.some((p) => p.includes("encoding")));
  });

  it("rejects an unknown bom policy instead of guessing", () => {
    const problems = validatePolicy({ rules: [{ match: ["*.json"], encoding: "utf-8", bom: "maybe" }] });
    assert.ok(problems.length > 0);
  });

  it("matches the basename, so *.json hits nested files", () => {
    const rules = [{ match: ["*.json"], encoding: "utf-8", bom: "forbid" }];
    assert.ok(matchRule("src/config/feff.json", rules));
  });

  it("ignores node_modules whether the glob has /** or not", () => {
    const ignore = ["node_modules/**"];
    assert.equal(isIgnored("node_modules/left-pad/index.js", ignore), true);
    assert.equal(isIgnored("src/index.js", ignore), false);
  });

  it("treats a bare directory name as 'this directory and everything in it'", () => {
    assert.equal(isIgnored("dist/app.js", ["dist"]), true);
    assert.equal(isIgnored("dist", ["dist"]), true);
    assert.equal(isIgnored("src/distribute.js", ["dist"]), false);
  });

  it("lets the first matching rule win", () => {
    const rules = [
      { match: ["*.json"], encoding: "utf-8", bom: "forbid" },
      { match: ["*.json"], encoding: "utf-8", bom: "require" },
    ];
    assert.equal(matchRule("package.json", rules).bom, "forbid");
  });
});

describe("checking", () => {
  const policy = normalizePolicy({
    rules: [
      { match: ["*.json"], encoding: "utf-8", bom: "forbid" },
      { match: ["*.csv"], encoding: "utf-8", bom: "require" },
      { match: ["*.ps1"], encoding: "utf-8", bom: "allow" },
    ],
  });

  it("flags the exact failure: a JSON file whose BOM survives JSON.parse", () => {
    const findings = checkFiles([{ path: "package.json", bytes: withBom('{"name":"x"}\n') }], policy);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /U\+FEFF/);
  });

  it("passes the same JSON without a BOM", () => {
    const findings = checkFiles([{ path: "package.json", bytes: utf8('{"name":"x"}\n') }], policy);
    assert.deepEqual(findings, []);
  });

  it("requires a BOM for CSV and accepts one", () => {
    const missing = checkFiles([{ path: "export.csv", bytes: utf8("名,值\n") }], policy);
    assert.equal(missing.length, 1);
    const present = checkFiles([{ path: "export.csv", bytes: withBom("名,值\n") }], policy);
    assert.deepEqual(present, []);
  });

  it("allows a PowerShell script either way", () => {
    const bare = checkFiles([{ path: "build.ps1", bytes: utf8("Write-Output 1\n") }], policy);
    const marked = checkFiles([{ path: "build.ps1", bytes: withBom("Write-Output 1\n") }], policy);
    assert.deepEqual(bare, []);
    assert.deepEqual(marked, []);
  });

  it("lets the default policy accept a UTF-16 PowerShell script", () => {
    const policy16 = normalizePolicy({ rules: [{ match: ["*.ps1"], encoding: "any", bom: "allow" }] });
    const units = Buffer.from("Write-Output 1\n", "utf16le");
    const bytes = new Uint8Array([0xff, 0xfe, ...units]);
    assert.deepEqual(checkFiles([{ path: "build.ps1", bytes }], policy16), []);
  });

  it("matches extensions regardless of case", () => {
    const findings = checkFiles([{ path: "src/App.JSON", bytes: withBom("{}\n") }], policy);
    assert.equal(findings.length, 1);
  });

  it("ignores a minified file in a subdirectory", () => {
    const minified = normalizePolicy({ rules: [{ match: ["*.js"], encoding: "utf-8", bom: "forbid" }] });
    const findings = checkFiles([{ path: "vendor/jquery.min.js", bytes: withBom("!function(){}\n") }], minified);
    assert.deepEqual(findings, []);
  });

  it("refuses to call UTF-16 a valid UTF-8 file", () => {
    const units = Buffer.from("{}\n", "utf16le");
    const bytes = new Uint8Array([0xff, 0xfe, ...units]);
    const findings = checkFiles([{ path: "data.json", bytes }], policy);
    assert.match(findings[0].message, /utf-16le/);
  });

  it("does not check files no rule covers", () => {
    const findings = checkFiles([{ path: "photo.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }], policy);
    assert.deepEqual(findings, []);
  });

  it("explains a JSON.parse failure caused by U+FEFF and ignores other failures", () => {
    const text = `\uFEFF{"a":1}`;
    assert.match(explainJson(text), /U\+FEFF/);
    assert.equal(explainJson("{not json"), null);
    assert.equal(explainJson('{"a":1}'), null);
  });
});

describe("fixing", () => {
  const forbid = { match: ["*.json"], encoding: "utf-8", bom: "forbid" };
  const require = { match: ["*.csv"], encoding: "utf-8", bom: "require" };

  it("strips a UTF-8 BOM and leaves the text untouched", () => {
    const result = fixBytes(withBom('{"a":1}\n'), forbid);
    assert.equal(result.changed, true);
    assert.deepEqual(result.bytes, utf8('{"a":1}\n'));
  });

  it("adds a UTF-8 BOM when the rule requires one", () => {
    const result = fixBytes(utf8("a,b\n"), require);
    assert.equal(result.changed, true);
    assert.equal(result.bytes[0], 0xef);
    assert.equal(result.bytes[1], 0xbb);
    assert.equal(result.bytes[2], 0xbf);
  });

  it("does not rewrite a file that already complies", () => {
    assert.equal(fixBytes(utf8("{}\n"), forbid).changed, false);
  });

  it("refuses to transcode UTF-16 instead of guessing", () => {
    const units = Buffer.from("{}\n", "utf16le");
    const bytes = new Uint8Array([0xff, 0xfe, ...units]);
    const result = fixBytes(bytes, forbid);
    assert.equal(result.changed, false);
    assert.match(result.reason, /transcode/);
  });
});

describe("command line", () => {
  it("fix leaves an ignored directory untouched", async () => {
    const { run } = await import("../bin/feff.js");
    const root = await mkdtemp(path.join(tmpdir(), "feff-"));
    try {
      await writeFile(path.join(root, "feff.json"), JSON.stringify({
        ignore: ["vendor/**"],
        rules: [{ match: ["*.json"], encoding: "utf-8", bom: "forbid" }],
      }));
      await writeFile(path.join(root, "kept.json"), withBom("{}\n"));
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(root, "vendor"));
      await writeFile(path.join(root, "vendor", "left.json"), withBom("{}\n"));

      const code = await run(["fix", root]);
      assert.equal(code, 0);
      assert.equal((await readFile(path.join(root, "kept.json"))).subarray(0, 3).toString("hex"), "7b7d0a");
      assert.equal((await readFile(path.join(root, "vendor", "left.json"))).subarray(0, 3).toString("hex"), "efbbbf");
      const read = await readTree(root, ["vendor/**"]);
      assert.deepEqual(read.files.map((file) => file.path), ["feff.json", "kept.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("check accepts a single file and judges it from the policy above it", async () => {
    const { run } = await import("../bin/feff.js");
    const root = await mkdtemp(path.join(tmpdir(), "feff-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "feff.json"), JSON.stringify({
        rules: [{ match: ["*.json"], encoding: "utf-8", bom: "forbid" }],
      }));
      await writeFile(path.join(root, "src", "data.json"), withBom("{}\n"));
      const code = await run(["check", path.join(root, "src", "data.json")]);
      assert.equal(code, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("why matches a path rule against the file's location, not just its name", async () => {
    const { run } = await import("../bin/feff.js");
    const root = await mkdtemp(path.join(tmpdir(), "feff-"));
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(line);
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "feff.json"), JSON.stringify({
        rules: [{ match: ["src/**/*.json"], encoding: "utf-8", bom: "require" }],
      }));
      await writeFile(path.join(root, "src", "data.json"), "{}\n");
      const code = await run(["why", path.join(root, "src", "data.json")]);
      assert.equal(code, 1);
      assert.ok(lines.some((line) => line.startsWith("verdict:") && line.includes("BOM required")), lines.join("\n"));
      assert.ok(lines.some((line) => line.includes("src/**/*.json") && line.includes("require")), lines.join("\n"));
    } finally {
      console.log = original;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps looking when the nearest feff.json is not readable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "feff-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "feff.json"), JSON.stringify({
        rules: [{ match: ["*.json"], encoding: "utf-8", bom: "forbid" }],
      }));
      await mkdir(path.join(root, "src", "feff.json"));
      const found = await findConfigRoot(path.join(root, "src", "data.json"));
      assert.equal(found, root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fix --dry-run changes nothing", async () => {
    const { run } = await import("../bin/feff.js");
    const root = await mkdtemp(path.join(tmpdir(), "feff-"));
    try {
      await writeFile(path.join(root, "kept.json"), withBom("{}\n"));
      const code = await run(["fix", "--dry-run", root]);
      assert.equal(code, 0);
      assert.equal((await readFile(path.join(root, "kept.json"))).subarray(0, 3).toString("hex"), "efbbbf");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a file over 32 MiB instead of reading it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "feff-"));
    try {
      const handle = await (await import("node:fs/promises")).open(path.join(root, "huge.json"), "w");
      await handle.truncate(32 * 1024 * 1024 + 1);
      await handle.close();
      const read = await readTree(root);
      assert.deepEqual(read.files, []);
      assert.equal(read.skipped.length, 1);
      assert.equal(read.skipped[0].path, "huge.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a policy file that is not UTF-8 instead of misreading it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "feff-"));
    try {
      const body = Buffer.from('{"rules":[]}', "utf16le");
      await writeFile(path.join(root, "feff.json"), Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
      const loaded = await loadPolicy(root);
      assert.match(loaded.error, /must be UTF-8/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("globs", () => {
  it("keeps * inside one path segment", () => {
    assert.equal(minimatch("a.json", "*.json"), true);
    assert.equal(minimatch("dir/a.json", "*.json"), false);
  });

  it("lets ** cross segments, including none", () => {
    assert.equal(minimatch("node_modules/pkg/index.js", "node_modules/**"), true);
    assert.equal(minimatch("src/pkg/index.js", "node_modules/**"), false);
  });

  it("matches a leading ** against a file at the root", () => {
    assert.equal(minimatch("package.json", "**/*.json"), true);
    assert.equal(minimatch("src/package.json", "**/*.json"), true);
    assert.equal(minimatch("readme.md", "**/*.json"), false);
  });
});
