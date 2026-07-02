import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "@/lib/server/secret-redaction";

const ignoredDirectoryNames = new Set([
  ".git",
  ".agy",
  ".antigravity",
  ".antigravitycli",
  ".gemini",
  ".next",
  ".orchestrator",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "out",
  "__pycache__",
  ".venv",
  "venv",
  ".ml-cache",
  "checkpoints",
  "mlruns",
  ".data",
  ".workspace",
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
]);

export const SECRET_IGNORE_REASON = "Excluded likely-secret file; not uploaded.";
export const SECRET_CONTENT_IGNORE_REASON = "Excluded file containing a likely secret value; not uploaded.";

const maxContentScanBytes = 256 * 1024;

const binaryScanSkipExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf",
  ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".wav", ".mov", ".avi", ".webm",
  ".exe", ".dll", ".so", ".dylib", ".wasm", ".bin",
  ".safetensors", ".pt", ".pth", ".onnx", ".joblib", ".pkl", ".gguf", ".npy", ".npz", ".parquet",
]);

function shouldScanFileContent(name: string, size: number): boolean {
  if (size === 0 || size > maxContentScanBytes) {
    return false;
  }
  return !binaryScanSkipExtensions.has(path.extname(name).toLowerCase());
}

async function fileLooksLikeSecret(absolutePath: string): Promise<boolean> {
  try {
    const content = (await readFile(absolutePath)).toString("utf8");
    return redactSecrets(content) !== content;
  } catch {
    return false;
  }
}

const secretFileNames = new Set([
  ".npmrc",
  ".yarnrc.yml",
  ".netrc",
  "_netrc",
  ".pypirc",
  ".git-credentials",
  ".htpasswd",
  ".dockercfg",
  ".pgpass",
  "credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "terraform.tfstate",
  "terraform.tfstate.backup",
]);

const secretFileExtensions = [
  ".pem",
  ".key",
  ".pfx",
  ".p12",
  ".p8",
  ".keystore",
  ".jks",
  ".ppk",
  ".tfvars",
  ".tfstate",
  ".kdbx",
];

const sharableEnvSuffixes = new Set(["example", "sample", "template", "dist", "defaults", "schema"]);

function isDotEnvSecret(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env") {
    return true;
  }
  if (lower.startsWith(".env.")) {
    return !sharableEnvSuffixes.has(lower.slice(5));
  }
  if (lower.endsWith(".env")) {
    const stem = lower.slice(0, -4);
    const lastDot = stem.lastIndexOf(".");
    const suffix = lastDot >= 0 ? stem.slice(lastDot + 1) : stem;
    return !sharableEnvSuffixes.has(suffix);
  }
  return false;
}

function isSecretFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (secretFileNames.has(lower)) {
    return true;
  }
  if (isDotEnvSecret(name)) {
    return true;
  }
  if (secretFileExtensions.some((ext) => lower.endsWith(ext))) {
    return true;
  }
  if (lower.endsWith(".json") && /service[-_.]?account|credentials?/.test(lower)) {
    return true;
  }
  return false;
}

const maxDepth = 40;
const maxFileBytes = 25 * 1024 * 1024;

export interface GithubExportFile {
  path: string;
  absolutePath: string;
  byteCount: number;
  executable: boolean;
}

export interface GithubExportIgnoredEntry {
  path: string;
  reason: string;
}

export interface GithubExportManifest {
  root: string;
  files: GithubExportFile[];
  ignored: GithubExportIgnoredEntry[];
  fileCount: number;
  byteCount: number;
  hasWorkflowFiles: boolean;
  warnings: string[];
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/");
}

function shouldIgnore(relativePath: string, name: string, isDirectory: boolean): string | null {
  if (isDirectory && ignoredDirectoryNames.has(name)) {
    return `Ignored generated/system directory: ${name}`;
  }
  if (!isDirectory && (name.endsWith(".tsbuildinfo") || name === ".DS_Store" || name === "Thumbs.db")) {
    return "Ignored generated metadata file.";
  }
  if (!isDirectory && isSecretFileName(name)) {
    return SECRET_IGNORE_REASON;
  }
  const normalized = normalizePath(relativePath);
  if (
    normalized === ".data/checkpoints" ||
    normalized.startsWith(".data/checkpoints/") ||
    normalized === ".data/artifacts" ||
    normalized.startsWith(".data/artifacts/") ||
    normalized === ".data/closed-dev-loop.json" ||
    normalized === ".workspace" ||
    normalized.startsWith(".workspace/")
  ) {
    return "Ignored orchestrator state.";
  }
  if (
    normalized.includes("/.orchestrator/") ||
    normalized.includes("/.gemini/") ||
    normalized.includes("/.antigravity/") ||
    normalized.includes("/.antigravitycli/") ||
    normalized.includes("/.agy/") ||
    normalized.includes("/node_modules/") ||
    normalized.includes("/.next/")
  ) {
    return "Ignored generated/system path.";
  }
  return null;
}

async function collect(root: string, current: string, depth: number, files: GithubExportFile[], ignored: GithubExportIgnoredEntry[]): Promise<void> {
  if (depth > maxDepth) {
    ignored.push({ path: normalizePath(current), reason: "Maximum export scan depth exceeded." });
    return;
  }
  const absoluteCurrent = path.join(root, current);
  const entries = await readdir(absoluteCurrent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const relativePath = current.length === 0 ? entry.name : path.join(current, entry.name);
    const normalized = normalizePath(relativePath);
    const ignoreReason = shouldIgnore(relativePath, entry.name, entry.isDirectory());
    if (ignoreReason !== null) {
      ignored.push({ path: normalized, reason: ignoreReason });
      continue;
    }
    if (entry.isSymbolicLink()) {
      ignored.push({ path: normalized, reason: "Symbolic links are not exported." });
      continue;
    }
    if (entry.isDirectory()) {
      await collect(root, relativePath, depth + 1, files, ignored);
      continue;
    }
    if (!entry.isFile()) {
      ignored.push({ path: normalized, reason: "Only regular files are exported." });
      continue;
    }
    const absolutePath = path.join(root, relativePath);
    const fileStat = await stat(absolutePath).catch(() => null);
    if (fileStat === null) {
      ignored.push({ path: normalized, reason: "File could not be read." });
      continue;
    }
    if (fileStat.size > maxFileBytes) {
      ignored.push({ path: normalized, reason: `File exceeds ${Math.floor(maxFileBytes / 1024 / 1024)}MB per-file export limit.` });
      continue;
    }
    if (shouldScanFileContent(entry.name, fileStat.size) && (await fileLooksLikeSecret(absolutePath))) {
      ignored.push({ path: normalized, reason: SECRET_CONTENT_IGNORE_REASON });
      continue;
    }
    files.push({
      path: normalized,
      absolutePath,
      byteCount: fileStat.size,
      executable: (fileStat.mode & 0o111) !== 0,
    });
  }
}

export async function createGithubExportManifest(root: string): Promise<GithubExportManifest> {
  const rootStat = await stat(root).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) {
    throw new Error("The active workspace folder does not exist.");
  }
  const files: GithubExportFile[] = [];
  const ignored: GithubExportIgnoredEntry[] = [];
  await collect(root, "", 0, files, ignored);
  files.sort((a, b) => a.path.localeCompare(b.path));
  ignored.sort((a, b) => a.path.localeCompare(b.path));
  const byteCount = files.reduce((sum, file) => sum + file.byteCount, 0);
  const hasWorkflowFiles = files.some((file) => file.path.startsWith(".github/workflows/"));
  const warnings: string[] = [];
  if (files.length === 0) {
    warnings.push("No exportable files were found in the active workspace.");
  }
  const secretExclusions = ignored.filter(
    (entry) => entry.reason === SECRET_IGNORE_REASON || entry.reason === SECRET_CONTENT_IGNORE_REASON,
  ).length;
  if (secretExclusions > 0) {
    warnings.push(`Excluded ${secretExclusions} likely-secret file(s) (such as .env or private keys); they were NOT uploaded. Review the ignored list before exporting, especially to a public repository.`);
  }
  if (hasWorkflowFiles) {
    warnings.push("Workflow files are present; OAuth tokens need the workflow scope to update them in existing repositories.");
  }
  if (byteCount > 200 * 1024 * 1024) {
    warnings.push("The export is large; GitHub API upload can take a while.");
  }
  return {
    root,
    files,
    ignored,
    fileCount: files.length,
    byteCount,
    hasWorkflowFiles,
    warnings,
  };
}

export async function readExportFileContent(file: GithubExportFile): Promise<string> {
  return (await readFile(file.absolutePath)).toString("base64");
}
