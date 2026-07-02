export interface ToolchainDiagnostic {
  id: string;
  label: string;
  command: string;
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface ToolchainProbe {
  id: string;
  label: string;
  executableNames: string[];
  versionArgs: string[];
  fallback: string;
}
