/**
 * Minimal glob → RegExp. Supports `*`, `?`, `**`, `{a,b}` and character classes,
 * matching against POSIX-style workspace-relative paths.
 *
 * A dependency-free implementation is deliberate: glob libraries are a common
 * source of ReDoS and path-escape surprises, and the subset used here is small.
 */
export function globToRegExp(glob: string, caseSensitive = process.platform !== 'win32'): RegExp {
  let re = '';
  let i = 0;
  let braceDepth = 0;

  while (i < glob.length) {
    const ch = glob[i]!;
    switch (ch) {
      case '*': {
        const isDouble = glob[i + 1] === '*';
        if (isDouble) {
          // `**/` matches zero or more directories; bare `**` matches anything.
          if (glob[i + 2] === '/') {
            re += '(?:[^/]*\\/)*';
            i += 3;
          } else {
            re += '.*';
            i += 2;
          }
        } else {
          re += '[^/]*';
          i += 1;
        }
        break;
      }
      case '?':
        re += '[^/]';
        i += 1;
        break;
      case '[': {
        const close = glob.indexOf(']', i + 1);
        if (close === -1) {
          re += '\\[';
          i += 1;
        } else {
          const body = glob.slice(i + 1, close).replace(/^!/, '^');
          re += `[${body}]`;
          i = close + 1;
        }
        break;
      }
      case '{':
        braceDepth++;
        re += '(?:';
        i += 1;
        break;
      case '}':
        if (braceDepth > 0) {
          braceDepth--;
          re += ')';
        } else {
          re += '\\}';
        }
        i += 1;
        break;
      case ',':
        re += braceDepth > 0 ? '|' : ',';
        i += 1;
        break;
      default:
        re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        i += 1;
    }
  }

  return new RegExp(`^${re}$`, caseSensitive ? '' : 'i');
}

/**
 * Patterns without a `/` match against the basename too, so `*.ts` behaves the
 * way people expect rather than only matching root-level files.
 */
export function makeMatcher(patterns: string[]): (relPath: string) => boolean {
  if (patterns.length === 0) return () => true;
  const compiled = patterns.map((p) => {
    const normalised = p.replace(/\\/g, '/');
    const anchored = normalised.includes('/');
    return { re: globToRegExp(anchored ? normalised : `**/${normalised}`), bare: !anchored, raw: normalised };
  });
  return (relPath: string) => {
    const posix = relPath.replace(/\\/g, '/');
    const base = posix.slice(posix.lastIndexOf('/') + 1);
    return compiled.some(({ re, bare }) => re.test(posix) || (bare && re.test(base)));
  };
}
