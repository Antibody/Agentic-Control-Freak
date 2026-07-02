import type { JsonObject } from "@/lib/shared/types";
import type {
  ApplicationKind,
  LanguageId,
  PackageEcosystem,
  StackDetectionResult,
} from "@/lib/shared/stack-descriptors";
import type { PreviewTargetSpec } from "@/lib/shared/preview-targets";
import type { VerificationCheckSpec } from "@/lib/shared/verification-checks";
import type { WorkspaceComponentAnalysis } from "@/lib/shared/workspace-components";

export interface ScaffoldResult {
  filesCreated: string[];
  notes: string[];
}

export interface StackPlugin {
  id: string;
  displayName: string;
  languages: LanguageId[];
  applicationKinds: ApplicationKind[];
  packageEcosystems: PackageEcosystem[];

  detectFromRequest(input: {
    userRequest: string;
  }): Promise<StackDetectionResult | null>;

  detectFromWorkspace(input: {
    workspacePath: string;
    relativeRoot: string;
  }): Promise<StackDetectionResult | null>;

  scaffold(input: {
    workspacePath: string;
    userRequest: string;
    componentName: string;
  }): Promise<ScaffoldResult>;

  analyze(input: {
    workspacePath: string;
    relativeRoot: string;
  }): Promise<WorkspaceComponentAnalysis>;

  install(input: {
    workspacePath: string;
    component: WorkspaceComponentAnalysis;
  }): Promise<unknown[]>;

  preview(input: {
    workspacePath: string;
    component: WorkspaceComponentAnalysis;
    port: number;
    host: string;
  }): Promise<PreviewTargetSpec[]>;

  verify(input: {
    workspacePath: string;
    component: WorkspaceComponentAnalysis;
    userRequest: string;
    explicitBuildAllowed: boolean;
  }): Promise<VerificationCheckSpec[]>;

  agentInstructions(input: {
    component: WorkspaceComponentAnalysis;
  }): Promise<string>;

  metadata?: JsonObject;
}
