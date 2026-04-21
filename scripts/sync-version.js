import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");

async function main() {
  const packageJsonPath = join(repoRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const version = readVersion(packageJson);

  await syncFile(join(repoRoot, "src/index.ts"), /export const VERSION = ".*";/, version);
  await syncFile(join(repoRoot, "tests/index.test.ts"), /expect\(VERSION\)\.toBe\(".*"\);/, version);
}

function readVersion(packageJson) {
  if (!packageJson || typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json is missing a valid version");
  }
  return packageJson.version;
}

async function syncFile(path, pattern, version) {
  const source = await readFile(path, "utf8");
  const replacement = buildReplacement(path, version);
  const updated = source.replace(pattern, replacement);

  if (updated === source) {
    throw new Error(`Version marker not found in ${path}`);
  }

  await writeFile(path, updated);
}

function buildReplacement(path, version) {
  if (path.endsWith("src/index.ts")) {
    return `export const VERSION = "${version}";`;
  }
  return `expect(VERSION).toBe("${version}");`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
