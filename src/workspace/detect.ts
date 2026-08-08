/**
 * Project detection.
 *
 * The point is not to classify every repo perfectly — it is to give the model a
 * short, high-signal brief (build system, test command, module layout,
 * conventions) so it does not have to read 40 files to find out how to run the
 * tests. Everything here is derived from the repo; nothing is hardcoded per
 * project.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ALWAYS_SKIP_DIRS } from '../security/paths.js';

export interface CommandSuggestion {
  /** Command line to run, already tailored to the detected tooling. */
  command: string;
  /** Where it must run from, relative to the workspace root. */
  cwd: string;
  source: string;
}

export interface ProjectModule {
  name: string;
  path: string;
  type: string;
}

export interface ProjectProfile {
  /** e.g. ["node", "java"] — monorepos legitimately have several. */
  languages: string[];
  buildSystems: string[];
  frameworks: string[];
  packageManager?: string;
  testFrameworks: string[];
  modules: ProjectModule[];
  /** Candidate commands, best first. Consumed by run_build / run_tests / run_lint. */
  build: CommandSuggestion[];
  test: CommandSuggestion[];
  lint: CommandSuggestion[];
  typecheck: CommandSuggestion[];
  install: CommandSuggestion[];
  /** Marker files that drove the detection — useful context for the model. */
  markers: string[];
  notes: string[];
}

function readIfExists(file: string, maxBytes = 512 * 1024): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  const raw = readIfExists(file);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

/** Windows uses the .cmd wrappers; the runner also falls back, this keeps the brief accurate. */
const isWin = process.platform === 'win32';
const mvnw = () => (isWin ? 'mvnw.cmd' : './mvnw');
const gradlew = () => (isWin ? 'gradlew.bat' : './gradlew');

function detectNode(root: string, rel: string, p: ProjectProfile): void {
  const pkgPath = path.join(root, rel, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) return;

  p.languages.push('node');
  p.markers.push(path.posix.join(rel || '.', 'package.json'));

  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const deps: Record<string, string> = {
    ...((pkg.dependencies ?? {}) as Record<string, string>),
    ...((pkg.devDependencies ?? {}) as Record<string, string>),
  };

  // Package manager: lockfile wins, then the packageManager field.
  let pm = 'npm';
  if (exists(root, path.join(rel, 'pnpm-lock.yaml'))) pm = 'pnpm';
  else if (exists(root, path.join(rel, 'yarn.lock'))) pm = 'yarn';
  else if (exists(root, path.join(rel, 'bun.lockb'))) pm = 'bun';
  else if (typeof pkg.packageManager === 'string') pm = pkg.packageManager.split('@')[0] ?? 'npm';
  p.packageManager ??= pm;
  p.buildSystems.push(pm);

  const runner = pm === 'npm' ? 'npm run' : `${pm} run`;
  const cwd = rel || '.';

  if (deps.typescript) p.languages.push('typescript');
  for (const [dep, name] of [
    ['next', 'next.js'], ['react', 'react'], ['vue', 'vue'], ['nuxt', 'nuxt'],
    ['svelte', 'svelte'], ['@angular/core', 'angular'], ['@nestjs/core', 'nestjs'],
    ['express', 'express'], ['fastify', 'fastify'], ['astro', 'astro'], ['electron', 'electron'],
  ] as const) {
    if (deps[dep]) p.frameworks.push(name);
  }
  for (const [dep, name] of [
    ['jest', 'jest'], ['vitest', 'vitest'], ['mocha', 'mocha'],
    ['@playwright/test', 'playwright'], ['cypress', 'cypress'], ['ava', 'ava'],
  ] as const) {
    if (deps[dep]) p.testFrameworks.push(name);
  }

  const src = `${cwd}/package.json`;
  if (scripts.build) p.build.push({ command: `${runner} build`, cwd, source: src });
  if (scripts.test) p.test.push({ command: `${runner} test`, cwd, source: src });
  else if (deps.vitest) p.test.push({ command: `${pm === 'npm' ? 'npx' : pm} vitest run`, cwd, source: 'vitest dependency' });
  else if (deps.jest) p.test.push({ command: `${pm === 'npm' ? 'npx' : pm} jest`, cwd, source: 'jest dependency' });
  if (scripts.lint) p.lint.push({ command: `${runner} lint`, cwd, source: src });
  else if (deps.eslint) p.lint.push({ command: `${pm === 'npm' ? 'npx' : pm} eslint .`, cwd, source: 'eslint dependency' });
  if (scripts.typecheck) p.typecheck.push({ command: `${runner} typecheck`, cwd, source: src });
  else if (scripts['type-check']) p.typecheck.push({ command: `${runner} type-check`, cwd, source: src });
  else if (deps.typescript) p.typecheck.push({ command: `${pm === 'npm' ? 'npx' : pm} tsc --noEmit`, cwd, source: 'typescript dependency' });
  p.install.push({ command: pm === 'npm' ? 'npm install' : `${pm} install`, cwd, source: src });

  // npm/pnpm/yarn workspaces → module map
  const ws = pkg.workspaces;
  const patterns = Array.isArray(ws) ? ws : Array.isArray((ws as { packages?: string[] })?.packages) ? (ws as { packages: string[] }).packages : [];
  for (const pattern of patterns) {
    const base = pattern.replace(/\/\*+$/, '');
    const dir = path.join(root, rel, base);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const modRel = path.posix.join(rel || '.', base, entry.name).replace(/^\.\//, '');
      if (exists(root, path.join(rel, base, entry.name, 'package.json'))) {
        p.modules.push({ name: entry.name, path: modRel, type: 'node' });
      }
    }
  }
}

function detectJava(root: string, p: ProjectProfile): void {
  const pom = readIfExists(path.join(root, 'pom.xml'));
  if (pom) {
    p.languages.push('java');
    p.buildSystems.push('maven');
    p.markers.push('pom.xml');

    const wrapper = exists(root, isWin ? 'mvnw.cmd' : 'mvnw');
    const mvn = wrapper ? mvnw() : 'mvn';
    p.build.push({ command: `${mvn} -B -DskipTests package`, cwd: '.', source: 'pom.xml' });
    p.test.push({ command: `${mvn} -B test`, cwd: '.', source: 'pom.xml' });
    p.install.push({ command: `${mvn} -B -DskipTests install`, cwd: '.', source: 'pom.xml' });

    if (/spring-boot/.test(pom)) p.frameworks.push('spring-boot');
    if (/quarkus/.test(pom)) p.frameworks.push('quarkus');
    if (/<artifactId>junit/.test(pom) || /junit-jupiter/.test(pom)) p.testFrameworks.push('junit');
    if (/mockito/.test(pom)) p.testFrameworks.push('mockito');
    if (/spotless|checkstyle|pmd/.test(pom)) {
      p.lint.push({ command: `${mvn} -B verify -DskipTests`, cwd: '.', source: 'pom.xml quality plugins' });
    }

    const javaVersion =
      pom.match(/<java\.version>([^<]+)</)?.[1] ??
      pom.match(/<maven\.compiler\.release>([^<]+)</)?.[1] ??
      pom.match(/<release>([^<]+)</)?.[1];
    if (javaVersion) p.notes.push(`Java ${javaVersion.trim()} (from pom.xml)`);

    const modulesBlock = pom.match(/<modules>([\s\S]*?)<\/modules>/)?.[1];
    if (modulesBlock) {
      for (const m of modulesBlock.matchAll(/<module>([^<]+)<\/module>/g)) {
        const name = m[1]!.trim();
        p.modules.push({ name, path: name, type: 'maven-module' });
      }
    }
  }

  const gradleFile = ['build.gradle', 'build.gradle.kts'].find((f) => exists(root, f));
  if (gradleFile) {
    const content = readIfExists(path.join(root, gradleFile)) ?? '';
    p.languages.push('java');
    p.buildSystems.push('gradle');
    p.markers.push(gradleFile);

    const wrapper = exists(root, isWin ? 'gradlew.bat' : 'gradlew');
    const g = wrapper ? gradlew() : 'gradle';
    p.build.push({ command: `${g} build -x test`, cwd: '.', source: gradleFile });
    p.test.push({ command: `${g} test`, cwd: '.', source: gradleFile });

    if (/org\.springframework\.boot/.test(content)) p.frameworks.push('spring-boot');
    if (/com\.android\.application|com\.android\.library/.test(content)) p.frameworks.push('android');
    if (/kotlin/.test(content)) p.languages.push('kotlin');

    const settings = readIfExists(path.join(root, 'settings.gradle')) ?? readIfExists(path.join(root, 'settings.gradle.kts'));
    if (settings) {
      for (const m of settings.matchAll(/include\s*\(?\s*["']:?([^"']+)["']/g)) {
        const name = m[1]!.replace(/^:/, '');
        p.modules.push({ name, path: name.split(':').join('/'), type: 'gradle-module' });
      }
    }
  }
}

function detectPython(root: string, p: ProjectProfile): void {
  const pyproject = readIfExists(path.join(root, 'pyproject.toml'));
  const hasReq = exists(root, 'requirements.txt');
  const hasSetup = exists(root, 'setup.py');
  if (!pyproject && !hasReq && !hasSetup) return;

  p.languages.push('python');
  if (pyproject) p.markers.push('pyproject.toml');
  if (hasReq) p.markers.push('requirements.txt');

  const usesPoetry = !!pyproject && /\[tool\.poetry\]/.test(pyproject);
  const usesUv = !!pyproject && (/\[tool\.uv\]/.test(pyproject) || exists(root, 'uv.lock'));
  p.buildSystems.push(usesPoetry ? 'poetry' : usesUv ? 'uv' : 'pip');

  const prefix = usesPoetry ? 'poetry run ' : usesUv ? 'uv run ' : '';
  const hasPytest = (pyproject && /pytest/.test(pyproject)) || exists(root, 'pytest.ini') || exists(root, 'tests');
  if (hasPytest) {
    p.testFrameworks.push('pytest');
    p.test.push({ command: `${prefix}pytest -q`, cwd: '.', source: 'pytest config' });
  } else {
    p.test.push({ command: `${prefix}python -m unittest discover`, cwd: '.', source: 'python default' });
  }
  if (pyproject && /ruff/.test(pyproject)) p.lint.push({ command: `${prefix}ruff check .`, cwd: '.', source: 'pyproject.toml' });
  if (pyproject && /mypy/.test(pyproject)) p.typecheck.push({ command: `${prefix}mypy .`, cwd: '.', source: 'pyproject.toml' });
  p.install.push({
    command: usesPoetry ? 'poetry install' : usesUv ? 'uv sync' : hasReq ? 'pip install -r requirements.txt' : 'pip install -e .',
    cwd: '.',
    source: 'python packaging',
  });

  if (pyproject) {
    if (/django/i.test(pyproject)) p.frameworks.push('django');
    if (/fastapi/i.test(pyproject)) p.frameworks.push('fastapi');
    if (/flask/i.test(pyproject)) p.frameworks.push('flask');
  }
}

function detectOthers(root: string, p: ProjectProfile): void {
  if (exists(root, 'go.mod')) {
    p.languages.push('go');
    p.buildSystems.push('go');
    p.markers.push('go.mod');
    p.build.push({ command: 'go build ./...', cwd: '.', source: 'go.mod' });
    p.test.push({ command: 'go test ./...', cwd: '.', source: 'go.mod' });
    p.lint.push({ command: 'go vet ./...', cwd: '.', source: 'go toolchain' });
  }
  if (exists(root, 'Cargo.toml')) {
    p.languages.push('rust');
    p.buildSystems.push('cargo');
    p.markers.push('Cargo.toml');
    p.build.push({ command: 'cargo build', cwd: '.', source: 'Cargo.toml' });
    p.test.push({ command: 'cargo test', cwd: '.', source: 'Cargo.toml' });
    p.lint.push({ command: 'cargo clippy', cwd: '.', source: 'Cargo.toml' });
  }
  const sln = fs.existsSync(root)
    ? fs.readdirSync(root).find((f) => f.endsWith('.sln') || f.endsWith('.csproj'))
    : undefined;
  if (sln) {
    p.languages.push('dotnet');
    p.buildSystems.push('dotnet');
    p.markers.push(sln);
    p.build.push({ command: 'dotnet build', cwd: '.', source: sln });
    p.test.push({ command: 'dotnet test', cwd: '.', source: sln });
  }
  if (exists(root, 'Gemfile')) {
    p.languages.push('ruby');
    p.buildSystems.push('bundler');
    p.markers.push('Gemfile');
    p.test.push({ command: 'bundle exec rspec', cwd: '.', source: 'Gemfile' });
  }
  if (exists(root, 'composer.json')) {
    p.languages.push('php');
    p.buildSystems.push('composer');
    p.markers.push('composer.json');
    p.test.push({ command: 'composer test', cwd: '.', source: 'composer.json' });
  }
  if (exists(root, 'pubspec.yaml')) {
    p.languages.push('dart');
    p.buildSystems.push('flutter');
    p.markers.push('pubspec.yaml');
    p.build.push({ command: 'flutter build apk --debug', cwd: '.', source: 'pubspec.yaml' });
    p.test.push({ command: 'flutter test', cwd: '.', source: 'pubspec.yaml' });
  }
  if (exists(root, 'Makefile')) {
    p.markers.push('Makefile');
    const mk = readIfExists(path.join(root, 'Makefile')) ?? '';
    if (/^test:/m.test(mk)) p.test.push({ command: 'make test', cwd: '.', source: 'Makefile' });
    if (/^build:/m.test(mk)) p.build.push({ command: 'make build', cwd: '.', source: 'Makefile' });
    if (/^lint:/m.test(mk)) p.lint.push({ command: 'make lint', cwd: '.', source: 'Makefile' });
  }
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    if (exists(root, f)) {
      p.frameworks.push('docker-compose');
      p.markers.push(f);
      break;
    }
  }
  if (exists(root, 'Dockerfile')) p.markers.push('Dockerfile');
}

/** Top-level source directories, so the model knows where code lives. */
function topLevelLayout(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !ALWAYS_SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
      .slice(0, 40);
  } catch {
    return [];
  }
}

export function detectProject(root: string): ProjectProfile & { layout: string[] } {
  const p: ProjectProfile = {
    languages: [],
    buildSystems: [],
    frameworks: [],
    testFrameworks: [],
    modules: [],
    build: [],
    test: [],
    lint: [],
    typecheck: [],
    install: [],
    markers: [],
    notes: [],
  };

  detectNode(root, '', p);
  detectJava(root, p);
  detectPython(root, p);
  detectOthers(root, p);

  // A frontend nested one level down (common: web/, frontend/, client/, ui/).
  for (const dir of ['web', 'frontend', 'client', 'ui', 'app']) {
    if (exists(root, path.join(dir, 'package.json'))) {
      detectNode(root, dir, p);
      p.modules.push({ name: dir, path: dir, type: 'node' });
    }
  }

  const dedupe = (a: string[]) => [...new Set(a)];
  p.languages = dedupe(p.languages);
  p.buildSystems = dedupe(p.buildSystems);
  p.frameworks = dedupe(p.frameworks);
  p.testFrameworks = dedupe(p.testFrameworks);

  if (p.test.length === 0) p.notes.push('No test command detected — ask before assuming how tests run.');

  return { ...p, layout: topLevelLayout(root) };
}
