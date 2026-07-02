import type { DependencyEcosystemPlugin, DependencyInstallPlan } from "@/lib/server/dependencies/contracts";
import type { PackageEcosystem } from "@/lib/shared/stack-descriptors";
import type { WorkspaceComponentAnalysis } from "@/lib/shared/workspace-components";

function plugin(
  id: PackageEcosystem,
  displayName: string,
  manifests: string[],
  lockFiles: string[],
  commands: string[],
): DependencyEcosystemPlugin {
  return {
    id,
    displayName,
    detectManifest: (component) => manifests.filter((file) => component.importantFiles.includes(file)),
    detectLockfile: (component) => lockFiles.filter((file) => component.importantFiles.includes(file)),
    installPlan: (component): DependencyInstallPlan => ({
      ecosystem: id,
      componentId: component.componentId,
      commands,
      manifestFiles: manifests.filter((file) => component.importantFiles.includes(file)),
      lockFiles: lockFiles.filter((file) => component.importantFiles.includes(file)),
      notes: commands.length === 0 ? ["No dependency install command is required for this ecosystem."] : [],
    }),
  };
}

const plugins: DependencyEcosystemPlugin[] = [
  plugin("npm", "npm", ["package.json"], ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"], ["npm install"]),
  plugin("pypi", "PyPI", ["requirements.txt", "pyproject.toml"], ["uv.lock", "poetry.lock"], ["python -m pip install -r requirements.txt"]),
  plugin("go-modules", "Go modules", ["go.mod"], ["go.sum"], ["go mod download"]),
  plugin("cargo", "Cargo", ["Cargo.toml"], ["Cargo.lock"], ["cargo fetch"]),
  {
    id: "nuget",
    displayName: "NuGet",
    detectManifest: (component) => component.importantFiles.filter((file) => file.endsWith(".csproj") || file.endsWith(".sln")),
    detectLockfile: (component) => component.importantFiles.filter((file) => file === "packages.lock.json"),
    installPlan: (component): DependencyInstallPlan => ({
      ecosystem: "nuget",
      componentId: component.componentId,
      commands: ["dotnet restore"],
      manifestFiles: component.importantFiles.filter((file) => file.endsWith(".csproj") || file.endsWith(".sln")),
      lockFiles: component.importantFiles.filter((file) => file === "packages.lock.json"),
      notes: [],
    }),
  },
  plugin("maven", "Maven", ["pom.xml"], [], ["mvn dependency:resolve"]),
  plugin("gradle", "Gradle", ["build.gradle", "build.gradle.kts"], ["gradle.lockfile"], ["gradle dependencies"]),
  plugin("packagist", "Packagist", ["composer.json"], ["composer.lock"], ["composer install"]),
  plugin("rubygems", "RubyGems", ["Gemfile"], ["Gemfile.lock"], ["bundle install"]),
  plugin("none", "No dependencies", [], [], []),
  plugin("unknown", "Unknown dependencies", [], [], []),
];

export function dependencyEcosystemPlugins(): DependencyEcosystemPlugin[] {
  return plugins;
}

export function dependencyEcosystemFor(ecosystem: PackageEcosystem): DependencyEcosystemPlugin {
  return plugins.find((candidate) => candidate.id === ecosystem) ?? plugins[plugins.length - 1];
}

export function dependencyInstallPlanForComponent(component: WorkspaceComponentAnalysis): DependencyInstallPlan {
  return dependencyEcosystemFor(component.packageEcosystem).installPlan(component);
}
