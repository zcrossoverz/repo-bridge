/**
 * Single source of the version number.
 *
 * Read from package.json at runtime rather than duplicated as a constant, so
 * `--version`, the MCP handshake and the npm package can never disagree — which
 * they silently would the first time someone bumped one and forgot the other.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageManifest {
  name: string;
  version: string;
  description?: string;
  homepage?: string;
}

// dist/version.js → ../package.json, which holds for both a source checkout and
// an installed package (<pkg>/dist/version.js).
const pkg = require('../package.json') as PackageManifest;

export const VERSION = pkg.version;
export const PACKAGE_NAME = pkg.name;
export const HOMEPAGE = pkg.homepage ?? 'https://github.com/zcrossoverz/repo-bridge';
