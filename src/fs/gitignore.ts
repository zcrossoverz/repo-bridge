/**
 * .gitignore matching.
 *
 * Written rather than pulled in so the bridge's only runtime dependency is the
 * MCP SDK — fewer moving parts to audit in a tool that has filesystem access.
 * Implements the subset of gitignore(5) that actually appears in repositories:
 * comments, negation, anchoring, directory-only rules, `*`, `?`, `**`, and
 * character classes. Last matching rule wins, as git specifies.
 */
interface Rule {
  re: RegExp;
  negated: boolean;
  dirOnly: boolean;
  source: string;
}

function patternToRegExp(pattern: string, anchored: boolean): RegExp {
  let re = anchored ? '' : '(?:.*/)?';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` → any number of directories; `**` elsewhere → anything.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        re += '\\[';
        i += 1;
      } else {
        re += `[${pattern.slice(i + 1, close).replace(/^!/, '^')}]`;
        i = close + 1;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < pattern.length) {
      re += pattern[i + 1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 2;
      continue;
    }
    re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }

  // An ignored directory implies everything under it.
  return new RegExp(`^${re}(?:/.*)?$`);
}

export class GitIgnore {
  private rules: Rule[] = [];

  add(content: string): this {
    for (const rawLine of content.split(/\r?\n/)) {
      // Trailing whitespace is insignificant unless escaped.
      const line = rawLine.replace(/(?<!\\)\s+$/, '');
      if (!line || line.startsWith('#')) continue;

      let pattern = line;
      const negated = pattern.startsWith('!');
      if (negated) pattern = pattern.slice(1);
      if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) pattern = pattern.slice(1);

      const dirOnly = pattern.endsWith('/');
      if (dirOnly) pattern = pattern.slice(0, -1);

      // A leading slash anchors to the root; so does any interior slash.
      const leadingSlash = pattern.startsWith('/');
      if (leadingSlash) pattern = pattern.slice(1);
      if (!pattern) continue;
      const anchored = leadingSlash || pattern.slice(0, -1).includes('/');

      this.rules.push({ re: patternToRegExp(pattern, anchored), negated, dirOnly, source: line });
    }
    return this;
  }

  /** Add plain directory names (used for the built-in skip list). */
  addDirectories(names: Iterable<string>): this {
    for (const name of names) this.add(`${name}/`);
    return this;
  }

  /**
   * @param relPath POSIX-style path relative to the repo root. A trailing `/`
   *                marks it as a directory, which activates dir-only rules.
   */
  ignores(relPath: string): boolean {
    const isDir = relPath.endsWith('/');
    const candidate = isDir ? relPath.slice(0, -1) : relPath;
    if (!candidate) return false;

    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) {
        // A dir-only rule still hides files *inside* the directory.
        if (!rule.re.test(candidate) || !candidate.includes('/')) continue;
      }
      if (!rule.re.test(candidate)) continue;
      ignored = !rule.negated;
    }
    return ignored;
  }
}
