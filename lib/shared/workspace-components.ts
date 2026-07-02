import type { JsonObject } from "@/lib/shared/types";
import type {
  ApplicationKind,
  CommandSpec,
  DetectionConfidence,
  DetectionEvidence,
  LanguageId,
  PackageEcosystem,
} from "@/lib/shared/stack-descriptors";
import type { PreviewTargetSpec } from "@/lib/shared/preview-targets";
import type { VerificationCheckSpec } from "@/lib/shared/verification-checks";

export interface WorkspaceDependencyEdge {
  fromComponentId: string;
  toComponentId: string;
  relationship: "runtime" | "build" | "test" | "unknown";
  metadata: JsonObject;
}

export interface WorkspaceDependencyGraph {
  edges: WorkspaceDependencyEdge[];
}

export interface WorkspaceComponentAnalysis {
  componentId: string;
  rootPath: string;
  displayName: string;
  language: LanguageId;
  framework: string;
  applicationKind: ApplicationKind;
  packageEcosystem: PackageEcosystem;
  packageManager: string | null;
  stackPluginId: string;
  confidence: DetectionConfidence;
  evidence: DetectionEvidence[];
  entrypoints: string[];
  commands: CommandSpec[];
  previewTargets: PreviewTargetSpec[];
  verificationChecks: VerificationCheckSpec[];
  importantFiles: string[];
  routes: string[];
  notes: string[];
}

export interface WorkspaceComponentGraph {
  components: WorkspaceComponentAnalysis[];
  dependencyGraph: WorkspaceDependencyGraph;
  suggestedPrimaryComponentId: string | null;
}
