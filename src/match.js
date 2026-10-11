/**
 * A small glob matcher. Supports *, **, ? and nothing else — the policy
 * language stays small on purpose. No character classes, no braces.
 *
 * `*` never crosses a `/`. `**` crosses any number of segments, including
 * zero. Matching is case-sensitive: the policy author decides case.
 */

export function minimatch(path, glob) {
  const re = globToRegExp(glob);
  return re.test(path);
}

function globToRegExp(glob) {
  let src = "^";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      src += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      src += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      src += "[^/]*";
      i += 1;
    } else if (glob[i] === "?") {
      src += "[^/]";
      i += 1;
    } else {
      src += escapeRegExp(glob[i]);
      i += 1;
    }
  }
  return new RegExp(`${src}$`);
}

function escapeRegExp(c) {
  return /[\\^$+?.()|[\]{}]/.test(c) ? `\\${c}` : c;
}
