/**
 * Secret protection — two independent jobs:
 *
 *  1. `isSecretPath` keeps credential files out of the model's context entirely.
 *  2. `redact` scrubs token-shaped strings from anything we *do* emit (logs,
 *     command output, error messages), because build tools happily echo secrets.
 */
import path from 'node:path';

/**
 * Path fragments that never reach the model. Matched against the POSIX-style
 * workspace-relative path AND each individual segment, case-insensitively.
 */
const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env($|\.|-)/i, // .env, .env.local, .env.production
  /(^|\/)\.envrc$/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.gcloud(\/|$)/i,
  /(^|\/)\.azure(\/|$)/i,
  /(^|\/)\.kube(\/(config)?|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|jks|keystore|asc|ppk)$/i,
  /(^|\/)credentials(\.json|\.yml|\.yaml)?$/i,
  /(^|\/)service-account.*\.json$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml|properties)$/i,
  /(^|\/)\.terraform(\/|$)/i,
  /\.tfstate(\.backup)?$/i,
  /(^|\/)(Cookies|Login Data|key[34]\.db|logins\.json)$/i, // browser profiles
  /(^|\/)\.password-store(\/|$)/i,
];

/** Extra operator-supplied fragments (plain substrings, case-insensitive). */
let extraPatterns: string[] = [];

export function configureSecretPatterns(patterns: string[]): void {
  extraPatterns = patterns.map((p) => p.toLowerCase()).filter(Boolean);
}

/**
 * `relPath` must be workspace-relative. Absolute host paths are normalised
 * first so a caller can pass either.
 */
export function isSecretPath(relPath: string): boolean {
  const posix = relPath.split(path.sep).join('/').replace(/^\.\//, '');
  if (SECRET_FILE_PATTERNS.some((re) => re.test(posix))) return true;
  const lower = posix.toLowerCase();
  return extraPatterns.some((p) => lower.includes(p));
}

/**
 * `.env.example` and friends are templates, not secrets — they're the single
 * most useful file for understanding a project's configuration surface.
 */
export function isSecretTemplate(relPath: string): boolean {
  return /\.(example|sample|template|dist)$/i.test(relPath) || /\.env\.(example|sample|template)$/i.test(relPath);
}

const REDACTION_RULES: Array<{ re: RegExp; replace: string }> = [
  // Provider-specific token shapes first — highest confidence.
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replace: '[REDACTED:github-token]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: '[REDACTED:github-pat]' },
  { re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g, replace: '[REDACTED:gitlab-token]' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replace: '[REDACTED:api-key]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: '[REDACTED:aws-key-id]' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: '[REDACTED:slack-token]' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: '[REDACTED:jwt]' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: '[REDACTED:private-key]' },
  // Credentials embedded in URLs: https://user:token@host
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, replace: '$1$2:[REDACTED]@' },
  // Generic KEY=value / "key": "value" assignments for secret-ish names.
  {
    re: /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|AUTH))\b(\s*[:=]\s*)(["']?)([^\s"',;]{6,})\3/gi,
    replace: '$1$2$3[REDACTED]$3',
  },
];

/** Values registered at startup (e.g. the bridge token) get exact-matched out. */
const literalSecrets = new Set<string>();

export function registerLiteralSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) literalSecrets.add(value);
}

export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  for (const value of literalSecrets) {
    if (out.includes(value)) out = out.split(value).join('[REDACTED]');
  }
  for (const { re, replace } of REDACTION_RULES) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Field names whose *value* is assumed to be credential material.
 *
 * Matched on word boundaries rather than as bare substrings: a blunt
 * /token|key|auth/ test also swallows `authMode`, `authorization_endpoint` and
 * `publicKey`, which turns operational logs into a wall of [REDACTED] and hides
 * the very details you need when debugging authentication.
 */
const SECRET_KEY_NAME =
  /(^|[._-])(token|secret|password|passwd|passphrase|apikey|api_key|access_key|secret_key|private_key|credential)s?([._-]|$)/i;

/**
 * Header names whose whole value is credential material. Matched exactly:
 * `authorization` is a secret, `authorization_endpoint` is a public URL.
 */
const SECRET_KEY_EXACT = new Set(['authorization', 'proxy_authorization', 'cookie', 'set_cookie']);

/** `githubToken` → `github_Token`, so camelCase keys hit the same word boundaries. */
function keyIsSecret(key: string): boolean {
  const normalised = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_');
  return SECRET_KEY_EXACT.has(normalised.toLowerCase()) || SECRET_KEY_NAME.test(normalised);
}

/** Deep-redact an arbitrary payload before logging it. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactValue) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = keyIsSecret(k) && typeof v === 'string' && v.length > 4
        ? '[REDACTED]'
        : redactValue(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** Test seam. */
export function resetSecretsForTests(): void {
  extraPatterns = [];
  literalSecrets.clear();
}
