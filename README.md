# feff

An encoding policy for a repository. You declare which files must be UTF-8
with no BOM, which must keep one, and feff tells you which files break the
rule — including the ones that fail silently.

```
package.json: UTF-8 BOM (EF BB BF) present. JSON.parse, many bundlers and
Node's utf8 reads keep the U+FEFF, so the file parses as if it had an
invisible first character.
```

## The problem it exists for

Windows PowerShell 5.1 writes "UTF-8" with a BOM (`Set-Content -Encoding utf8`,
`Out-File -Encoding utf8`). Node does not strip that BOM:

```js
JSON.parse(readFileSync("package.json", "utf8"));
// SyntaxError: Unexpected token '', "{
```

The file looks fine in an editor. The first three bytes are `EF BB BF`, which
decode to U+FEFF, and `JSON.parse` does not ignore it. The same bytes also
break bundlers, YAML parsers and anything else that trusts a `utf8` read.

Other tools check line endings, trailing whitespace and charsets. None of them
let you say "JSON must not have a BOM, CSV must have one, PowerShell may go
either way" and then enforce it. That is the whole of feff.

## Install

```
npm install feff
```

Node 18 or newer. No dependencies.

## Use

Check the current directory against `feff.json`, or against the built-in
defaults when there is no config:

```
feff check
feff check . --json
```

The defaults: no BOM for source files, JSON, Markdown and YAML; a BOM required
for CSV (Excel on Windows misreads a BOM-less CSV); PowerShell scripts exempt,
because the BOM is load-bearing there.

Rewrite files that can be fixed by adding or removing a UTF-8 BOM:

```
feff fix
```

feff will not transcode. A UTF-16 file is reported and left untouched, because
guessing a source encoding is how files get silently destroyed.

Explain one file. The verdict is exactly what `check` would report for it, and
the exit code matches: `1` when the file breaks the policy, `0` when it passes
or is ignored.

```
feff why src/package.json
```

Write a starter config:

```
feff init
```

Exit codes: `0` clean, `1` a file breaks the policy, `2` the policy file
itself is broken.

## Policy

`feff.json`:

```json
{
  "ignore": ["vendor/**"],
  "rules": [
    { "match": ["*.json", "*.js", "*.ts", "*.md"], "encoding": "utf-8", "bom": "forbid" },
    { "match": ["*.ps1"], "encoding": "utf-8", "bom": "allow" },
    { "match": ["*.csv"], "encoding": "utf-8", "bom": "require" }
  ]
}
```

`bom` is `forbid`, `require` or `allow`. The first matching rule wins. Globs
are `*` (one path segment), `**` (any number) and `?`. Files no rule matches
are not checked, so a `.png` never becomes an error.

`ignore` is added on top of the built-in ignores (`node_modules`, `.git`,
`dist`, `build`, `coverage`). A bare directory name means that directory and
everything inside it, so `"vendor"` and `"vendor/**"` do the same thing.

## CI

```yaml
- run: npx feff check
```

`--json` prints a machine-readable list for anything that wants to annotate a
pull request.

## What it deliberately does not do

- No transcoding and no encoding detection beyond BOMs. If feff cannot prove
  the file is the encoding it claims, it refuses.
- No opinion about line endings, indentation or trailing whitespace.
- It does not shell out, hit the network, or read `node_modules`.
