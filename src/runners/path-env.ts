import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export function childProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  nextEnv.PATH = executablePath(env);
  return nextEnv;
}

export function executablePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const entries = [
    ...pathEntries(env.PATH),
    ...configuredToolDirs(env),
    ...(home ? userToolDirs(home) : []),
    ...systemToolDirs(),
  ];
  return uniquePath(entries).join(delimiter);
}

function configuredToolDirs(env: NodeJS.ProcessEnv): string[] {
  const entries: string[] = [];
  const npmPrefix = firstEnv(env, "npm_config_prefix", "NPM_CONFIG_PREFIX");
  const pnpmHome = firstEnv(env, "PNPM_HOME");
  const bunInstall = firstEnv(env, "BUN_INSTALL");

  if (npmPrefix) entries.push(join(npmPrefix, "bin"));
  if (pnpmHome) entries.push(pnpmHome);
  if (bunInstall) entries.push(join(bunInstall, "bin"));
  return entries;
}

function userToolDirs(home: string): string[] {
  return [
    join(home, ".npm-global", "bin"),
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
  ];
}

function systemToolDirs(): string[] {
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
}

function pathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue.split(delimiter);
}

function uniquePath(entries: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const entry of entries) {
    if (!isUsablePathEntry(entry) || seen.has(entry)) continue;
    seen.add(entry);
    unique.push(entry);
  }

  return unique;
}

function isUsablePathEntry(entry: string): boolean {
  if (entry.length === 0) return false;
  if (entry.includes(delimiter)) return false;
  return !/[\0\n\r]/.test(entry);
}

function firstEnv(env: NodeJS.ProcessEnv, ...names: string[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return null;
}
