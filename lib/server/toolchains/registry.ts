import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveDotnetCommand } from "@/lib/server/runtime/dotnet-resolver";
import { resolveExecutable } from "@/lib/server/runtime/executable-resolver";
import type { ToolchainDiagnostic, ToolchainProbe } from "@/lib/server/toolchains/contracts";

const execFileAsync = promisify(execFile);

const probes: ToolchainProbe[] = [
  { id: "go", label: "Go", executableNames: ["go"], versionArgs: ["version"], fallback: "go" },
  { id: "rust", label: "Rust Cargo", executableNames: ["cargo"], versionArgs: ["--version"], fallback: "cargo" },
  { id: "dotnet", label: ".NET SDK", executableNames: ["dotnet"], versionArgs: ["--version"], fallback: "dotnet" },
  { id: "java", label: "Java", executableNames: ["java"], versionArgs: ["-version"], fallback: "java" },
  { id: "javac", label: "Java Compiler", executableNames: ["javac"], versionArgs: ["-version"], fallback: "javac" },
  { id: "maven", label: "Maven", executableNames: ["mvn"], versionArgs: ["--version"], fallback: "mvn" },
  { id: "gradle", label: "Gradle", executableNames: ["gradle"], versionArgs: ["--version"], fallback: "gradle" },
  { id: "php", label: "PHP", executableNames: ["php"], versionArgs: ["--version"], fallback: "php" },
  { id: "composer", label: "Composer", executableNames: ["composer"], versionArgs: ["--version"], fallback: "composer" },
  { id: "ruby", label: "Ruby", executableNames: ["ruby"], versionArgs: ["--version"], fallback: "ruby" },
  { id: "bundler", label: "Bundler", executableNames: ["bundle"], versionArgs: ["--version"], fallback: "bundle" },
];

function firstVersionLine(output: string): string | null {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
}

export async function probeToolchain(probe: ToolchainProbe): Promise<ToolchainDiagnostic> {
  const executable = probe.id === "dotnet"
    ? await resolveDotnetCommand()
    : await resolveExecutable({
        names: probe.executableNames,
        fallback: probe.fallback,
      });
  try {
    const result = await execFileAsync(executable.command, probe.versionArgs, { timeout: 7000 });
    return {
      id: probe.id,
      label: probe.label,
      command: executable.command,
      available: true,
      version: firstVersionLine(`${result.stdout}\n${result.stderr}`),
      error: null,
    };
  } catch (error) {
    return {
      id: probe.id,
      label: probe.label,
      command: executable.command,
      available: false,
      version: null,
      error: error instanceof Error ? error.message : "Unable to run version probe.",
    };
  }
}

export async function getPolyglotToolchainDiagnostics(): Promise<ToolchainDiagnostic[]> {
  return Promise.all(probes.map(probeToolchain));
}
