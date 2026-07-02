import type { JsonObject } from "@/lib/shared/types";

export type LanguageId =
  | "javascript"
  | "typescript"
  | "python"
  | "java"
  | "csharp"
  | "go"
  | "rust"
  | "php"
  | "ruby"
  | "r"
  | "html"
  | "css"
  | "unknown";

export type ApplicationKind =
  | "static-site"
  | "single-page-app"
  | "server-rendered-web"
  | "backend-api"
  | "fullstack-app"
  | "cli"
  | "library"
  | "script"
  | "report"
  | "unknown";

export type PackageEcosystem =
  | "npm"
  | "pypi"
  | "maven"
  | "gradle"
  | "nuget"
  | "go-modules"
  | "cargo"
  | "packagist"
  | "rubygems"
  | "cran"
  | "none"
  | "unknown";

export type DetectionConfidence = "low" | "medium" | "high";

export interface DetectionEvidence {
  filePath: string;
  reason: string;
  confidence: DetectionConfidence;
}

export interface StackDetectionResult {
  stackId: string;
  language: LanguageId;
  framework: string;
  applicationKind: ApplicationKind;
  confidence: DetectionConfidence;
  evidence: DetectionEvidence[];
}

export interface CommandSpec {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  allowNetwork: boolean;
  metadata?: JsonObject;
}
