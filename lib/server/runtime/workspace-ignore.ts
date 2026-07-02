export const IGNORED_WORKSPACE_DIRS = new Set([
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
  "mlruns",
  ".ml-cache",
]);

const ignoredWorkspaceFileExtensions = [
  ".pt",
  ".pth",
  ".safetensors",
  ".gguf",
  ".onnx",
  ".joblib",
  ".pkl",
];

export function hasIgnoredModelExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ignoredWorkspaceFileExtensions.some((ext) => lower.endsWith(ext));
}
