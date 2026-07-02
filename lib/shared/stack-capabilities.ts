import type { PreviewAppType, ProjectStack } from "@/lib/shared/types";

export type PreviewSurface = "live-web" | "static-files" | "python-report" | "r-report" | "none";
export type DependencyInstallerKind = "node-package-manager" | "python-requirements" | "node-and-python" | "r-packages" | "none";
export type VerificationFamily = "node" | "python" | "r" | "static" | "none";

export interface StackCapabilities {
  stack: PreviewAppType;
  previewSurface: PreviewSurface;
  dependencyInstaller: DependencyInstallerKind;
  verificationFamily: VerificationFamily;
  supportsBrowserSnapshot: boolean;
  supportsPythonRunParams: boolean;
  filtersGeneratedPreviewArtifacts: boolean;
  supportsExperimentRuntime?: boolean;
  supportsRRunParams?: boolean;
}

const capabilities: Record<PreviewAppType, StackCapabilities> = {
  "static-html": {
    stack: "static-html",
    previewSurface: "static-files",
    dependencyInstaller: "none",
    verificationFamily: "static",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  next: {
    stack: "next",
    previewSurface: "live-web",
    dependencyInstaller: "node-package-manager",
    verificationFamily: "node",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  "vite-react": {
    stack: "vite-react",
    previewSurface: "live-web",
    dependencyInstaller: "node-package-manager",
    verificationFamily: "node",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  "node-cli": {
    stack: "node-cli",
    previewSurface: "none",
    dependencyInstaller: "node-package-manager",
    verificationFamily: "node",
    supportsBrowserSnapshot: false,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  "node-express": {
    stack: "node-express",
    previewSurface: "live-web",
    dependencyInstaller: "node-package-manager",
    verificationFamily: "node",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  node: {
    stack: "node",
    previewSurface: "live-web",
    dependencyInstaller: "node-package-manager",
    verificationFamily: "node",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  "python-script": {
    stack: "python-script",
    previewSurface: "python-report",
    dependencyInstaller: "python-requirements",
    verificationFamily: "python",
    supportsBrowserSnapshot: false,
    supportsPythonRunParams: true,
    filtersGeneratedPreviewArtifacts: true,
  },
  "python-ml": {
    stack: "python-ml",
    previewSurface: "python-report",
    dependencyInstaller: "python-requirements",
    verificationFamily: "python",
    supportsBrowserSnapshot: false,
    supportsPythonRunParams: true,
    filtersGeneratedPreviewArtifacts: true,
    supportsExperimentRuntime: true,
  },
  "r-script": {
    stack: "r-script",
    previewSurface: "r-report",
    dependencyInstaller: "r-packages",
    verificationFamily: "r",
    supportsBrowserSnapshot: false,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: true,
    supportsRRunParams: true,
  },
  "r-shiny": {
    stack: "r-shiny",
    previewSurface: "live-web",
    dependencyInstaller: "r-packages",
    verificationFamily: "r",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  "python-flask": {
    stack: "python-flask",
    previewSurface: "live-web",
    dependencyInstaller: "python-requirements",
    verificationFamily: "python",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  "python-django": {
    stack: "python-django",
    previewSurface: "live-web",
    dependencyInstaller: "python-requirements",
    verificationFamily: "python",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  go: {
    stack: "go",
    previewSurface: "live-web",
    dependencyInstaller: "none",
    verificationFamily: "none",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  rust: {
    stack: "rust",
    previewSurface: "live-web",
    dependencyInstaller: "none",
    verificationFamily: "none",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  csharp: {
    stack: "csharp",
    previewSurface: "live-web",
    dependencyInstaller: "none",
    verificationFamily: "none",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  java: {
    stack: "java",
    previewSurface: "live-web",
    dependencyInstaller: "none",
    verificationFamily: "none",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  php: {
    stack: "php",
    previewSurface: "live-web",
    dependencyInstaller: "none",
    verificationFamily: "none",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  ruby: {
    stack: "ruby",
    previewSurface: "live-web",
    dependencyInstaller: "none",
    verificationFamily: "none",
    supportsBrowserSnapshot: true,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
  unknown: {
    stack: "unknown",
    previewSurface: "none",
    dependencyInstaller: "none",
    verificationFamily: "none",
    supportsBrowserSnapshot: false,
    supportsPythonRunParams: false,
    filtersGeneratedPreviewArtifacts: false,
  },
};

export function stackCapabilities(stack: PreviewAppType | ProjectStack | "unknown"): StackCapabilities {
  return capabilities[stack as PreviewAppType] ?? capabilities.unknown;
}

export function isGeneratedPreviewArtifact(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return (
    normalized === ".orchestrator/python-preview" ||
    normalized.startsWith(".orchestrator/python-preview/") ||
    normalized === ".orchestrator/r-preview" ||
    normalized.startsWith(".orchestrator/r-preview/")
  );
}
