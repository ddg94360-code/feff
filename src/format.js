/** Render findings the way a CI log should read: one line per failure, path first. */

export function formatFindings(findings) {
  return findings.map((f) => `${f.path}: ${f.message}`).join("\n");
}

export function formatJson(findings) {
  return JSON.stringify(
    findings.map((f) => ({ path: f.path, rule: f.rule, severity: f.severity, message: f.message })),
    null,
    2,
  );
}
