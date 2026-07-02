import type { PackageEcosystem } from "@/lib/shared/stack-descriptors";
import type { WorkspaceComponentAnalysis } from "@/lib/shared/workspace-components";

export interface DependencyInstallPlan {
  ecosystem: PackageEcosystem;
  componentId: string;
  commands: string[];
  manifestFiles: string[];
  lockFiles: string[];
  notes: string[];
}

export interface DependencyEcosystemPlugin {
  id: PackageEcosystem;
  displayName: string;
  detectManifest(component: WorkspaceComponentAnalysis): string[];
  detectLockfile(component: WorkspaceComponentAnalysis): string[];
  installPlan(component: WorkspaceComponentAnalysis): DependencyInstallPlan;
}
