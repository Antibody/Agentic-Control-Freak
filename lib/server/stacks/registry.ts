import type { ProjectStack } from "@/lib/shared/types";
import type {
  ApplicationKind,
  CommandSpec,
  DetectionConfidence,
  DetectionEvidence,
  LanguageId,
  PackageEcosystem,
  StackDetectionResult,
} from "@/lib/shared/stack-descriptors";
import type { PreviewSurface, PreviewTargetSpec } from "@/lib/shared/preview-targets";
import type { VerificationCheckFamily, VerificationCheckSpec } from "@/lib/shared/verification-checks";
import type { WorkspaceComponentAnalysis, WorkspaceComponentGraph } from "@/lib/shared/workspace-components";
import type { StackPlugin } from "@/lib/server/stacks/contracts";

interface LegacyStackDescriptor {
  stack: ProjectStack;
  displayName: string;
  language: LanguageId;
  framework: string;
  applicationKind: ApplicationKind;
  packageEcosystem: PackageEcosystem;
  previewSurface: PreviewSurface;
  requestHints: RegExp[];
  workspaceEvidence: string[];
}

export interface LegacyComponentInput {
  workspacePath: string;
  stack: ProjectStack;
  packageManager: string | null;
  importantFiles: string[];
  detectedRoutes: string[];
  verificationCommands: string[];
  notes: string[];
}

const legacyDescriptors: LegacyStackDescriptor[] = [
  {
    stack: "static-html",
    displayName: "Static HTML",
    language: "html",
    framework: "static-html",
    applicationKind: "static-site",
    packageEcosystem: "none",
    previewSurface: "static-files",
    requestHints: [/\b(static|single-file|plain html|no framework)\b/i],
    workspaceEvidence: ["index.html", "public/index.html"],
  },
  {
    stack: "next",
    displayName: "Next.js",
    language: "typescript",
    framework: "next",
    applicationKind: "server-rendered-web",
    packageEcosystem: "npm",
    previewSurface: "browser",
    requestHints: [/\bnext(?:\.js|js)?\b/i],
    workspaceEvidence: ["app/page.tsx", "pages/index.tsx", "next.config.js", "next.config.ts"],
  },
  {
    stack: "vite-react",
    displayName: "Vite React",
    language: "typescript",
    framework: "vite-react",
    applicationKind: "single-page-app",
    packageEcosystem: "npm",
    previewSurface: "browser",
    requestHints: [/\bvite\b/i, /\breact\b/i],
    workspaceEvidence: ["vite.config.ts", "vite.config.js", "src/App.tsx", "src/main.tsx"],
  },
  {
    stack: "node-cli",
    displayName: "Node CLI",
    language: "typescript",
    framework: "node",
    applicationKind: "cli",
    packageEcosystem: "npm",
    previewSurface: "cli-output",
    requestHints: [/\bnode(?:\.js|js)?\b.*\b(?:cli|command line)\b/i, /\b(?:cli|command line)\b.*\bnode(?:\.js|js)?\b/i, /\b(?:cli|command line)\b/i],
    workspaceEvidence: ["package.json", "src/index.ts", "index.js"],
  },
  {
    stack: "node-express",
    displayName: "Express",
    language: "javascript",
    framework: "express",
    applicationKind: "backend-api",
    packageEcosystem: "npm",
    previewSurface: "browser",
    requestHints: [/\bexpress\b|\bfastify\b|\bnode(?:\.js|js)?\s+(?:api|server|backend)\b/i],
    workspaceEvidence: ["server.js", "src/server.js", "app.js"],
  },
  {
    stack: "python-script",
    displayName: "Python Script",
    language: "python",
    framework: "python",
    applicationKind: "script",
    packageEcosystem: "pypi",
    previewSurface: "generated-report",
    requestHints: [/\bpython\s+(?:script|cli|plot|chart|graph|visuali[sz]ation|report|analysis)\b/i, /\bmatplotlib|pyplot|seaborn\b/i],
    workspaceEvidence: ["main.py", "requirements.txt", "pyproject.toml"],
  },
  {
    stack: "python-flask",
    displayName: "Flask",
    language: "python",
    framework: "flask",
    applicationKind: "backend-api",
    packageEcosystem: "pypi",
    previewSurface: "browser",
    requestHints: [/\bflask|fastapi|python web\b/i],
    workspaceEvidence: ["app.py", "requirements.txt"],
  },
  {
    stack: "python-django",
    displayName: "Django",
    language: "python",
    framework: "django",
    applicationKind: "server-rendered-web",
    packageEcosystem: "pypi",
    previewSurface: "browser",
    requestHints: [/\bdjango\b/i],
    workspaceEvidence: ["manage.py", "requirements.txt"],
  },
  {
    stack: "r-shiny",
    displayName: "Shiny",
    language: "r",
    framework: "shiny",
    applicationKind: "server-rendered-web",
    packageEcosystem: "cran",
    previewSurface: "browser",
    requestHints: [/\bshiny\b/i, /\br\s+shiny\b/i],
    workspaceEvidence: ["app.R", "ui.R", "server.R"],
  },
  {
    stack: "r-script",
    displayName: "R Script",
    language: "r",
    framework: "r",
    applicationKind: "script",
    packageEcosystem: "cran",
    previewSurface: "generated-report",
    requestHints: [/\bggplot2?\b|\btidyverse\b|\bdplyr\b|\brscript\b|\bcran\b/i, /\br\s+(?:script|plot|chart|graph|visuali[sz]ation|markdown|analysis|programming|language)\b/i, /\b(?:in|using|with)\s+r\b/i],
    workspaceEvidence: ["main.R", "DESCRIPTION", "renv.lock"],
  },
  {
    stack: "go",
    displayName: "Go HTTP",
    language: "go",
    framework: "standard-http",
    applicationKind: "backend-api",
    packageEcosystem: "go-modules",
    previewSurface: "browser",
    requestHints: [/\bgo(?:lang)?\b/i],
    workspaceEvidence: ["go.mod", "main.go"],
  },
  {
    stack: "rust",
    displayName: "Rust HTTP",
    language: "rust",
    framework: "axum-or-standard-http",
    applicationKind: "backend-api",
    packageEcosystem: "cargo",
    previewSurface: "browser",
    requestHints: [/\brust\b|\bcargo\b/i],
    workspaceEvidence: ["Cargo.toml", "src/main.rs"],
  },
  {
    stack: "csharp",
    displayName: "ASP.NET Core",
    language: "csharp",
    framework: "aspnet-core",
    applicationKind: "backend-api",
    packageEcosystem: "nuget",
    previewSurface: "browser",
    requestHints: [/\bc#\b|\bcsharp\b|\basp\.?net\b|\bdotnet\b/i],
    workspaceEvidence: ["Program.cs"],
  },
  {
    stack: "java",
    displayName: "Java",
    language: "java",
    framework: "spring-or-jdk-http",
    applicationKind: "backend-api",
    packageEcosystem: "maven",
    previewSurface: "browser",
    requestHints: [/\bjava\b|\bspring boot\b|\bmaven\b|\bgradle\b/i],
    workspaceEvidence: ["pom.xml", "build.gradle", "build.gradle.kts"],
  },
  {
    stack: "php",
    displayName: "PHP",
    language: "php",
    framework: "plain-php",
    applicationKind: "server-rendered-web",
    packageEcosystem: "packagist",
    previewSurface: "browser",
    requestHints: [/\bphp\b|\blaravel\b|\bcomposer\b/i],
    workspaceEvidence: ["composer.json", "public/index.php", "index.php"],
  },
  {
    stack: "ruby",
    displayName: "Ruby",
    language: "ruby",
    framework: "rack-or-rails",
    applicationKind: "server-rendered-web",
    packageEcosystem: "rubygems",
    previewSurface: "browser",
    requestHints: [/\bruby\b|\brails\b|\brack\b|\bbundler\b/i],
    workspaceEvidence: ["Gemfile", "config.ru", "app.rb"],
  },
  {
    stack: "unknown",
    displayName: "Unknown",
    language: "unknown",
    framework: "unknown",
    applicationKind: "unknown",
    packageEcosystem: "unknown",
    previewSurface: "none",
    requestHints: [],
    workspaceEvidence: [],
  },
];

function descriptorForStack(stack: ProjectStack): LegacyStackDescriptor {
  return legacyDescriptors.find((descriptor) => descriptor.stack === stack) ?? legacyDescriptors[legacyDescriptors.length - 1];
}

function detectionForDescriptor(
  descriptor: LegacyStackDescriptor,
  confidence: DetectionConfidence,
  evidence: DetectionEvidence[],
): StackDetectionResult {
  return {
    stackId: descriptor.stack,
    language: descriptor.language,
    framework: descriptor.framework,
    applicationKind: descriptor.applicationKind,
    confidence,
    evidence,
  };
}

function makeCommandSpec(id: string, label: string, command: string, cwd: string): CommandSpec {
  return {
    id,
    label,
    command,
    args: [],
    cwd,
    env: {},
    timeoutMs: 120000,
    allowNetwork: false,
  };
}

function verificationFamilyFor(command: string): VerificationCheckFamily {
  const normalized = command.toLowerCase();
  if (/\bbuild\b/.test(normalized)) return "build";
  if (/\blint\b/.test(normalized)) return "lint";
  if (/\btypecheck\b|\btsc\b/.test(normalized)) return "typecheck";
  if (/\btest\b|\bpytest\b|\brspec\b/.test(normalized)) return "unit-test";
  if (/\bpy_compile\b|\bruby -c\b|\bphp -l\b/.test(normalized)) return "syntax";
  return "custom";
}

function verificationChecks(commands: string[], cwd: string): VerificationCheckSpec[] {
  return commands.map((command, index) => ({
    id: `verify-${index + 1}`,
    label: command,
    family: verificationFamilyFor(command),
    required: true,
    command: makeCommandSpec(`verify-command-${index + 1}`, command, command, cwd),
    metadata: { source: "legacy-verification-command" },
  }));
}

function previewTargets(descriptor: LegacyStackDescriptor): PreviewTargetSpec[] {
  if (descriptor.previewSurface === "none") {
    return [];
  }
  return [
    {
      id: "primary-preview",
      label: `${descriptor.displayName} preview`,
      surface: descriptor.previewSurface,
      command: null,
      portEnvName: descriptor.previewSurface === "browser" ? "PORT" : null,
      healthPaths: descriptor.previewSurface === "browser" || descriptor.previewSurface === "static-files" ? ["/"] : [],
      staticRoot: descriptor.previewSurface === "static-files" ? "." : null,
      metadata: { source: "legacy-preview-manager" },
    },
  ];
}

function detectionEvidence(input: LegacyComponentInput, descriptor: LegacyStackDescriptor): DetectionEvidence[] {
  const exactEvidence = input.importantFiles
    .filter((file) => descriptor.workspaceEvidence.includes(file))
    .map((file): DetectionEvidence => ({
      filePath: file,
      reason: `${descriptor.displayName} evidence file detected.`,
      confidence: "high",
    }));
  if (exactEvidence.length > 0) {
    return exactEvidence;
  }
  if (input.stack !== "unknown") {
    return [
      {
        filePath: ".",
        reason: `Legacy workspace analyzer classified this component as ${input.stack}.`,
        confidence: "medium",
      },
    ];
  }
  return [
    {
      filePath: ".",
      reason: "No known stack evidence was detected.",
      confidence: "low",
    },
  ];
}

export function createWorkspaceComponentFromLegacyStack(input: LegacyComponentInput): WorkspaceComponentAnalysis {
  const descriptor = descriptorForStack(input.stack);
  const confidence: DetectionConfidence = input.stack === "unknown" ? "low" : "high";
  const rootNotes = input.stack === "unknown"
    ? ["No stack plugin matched the root workspace yet.", ...input.notes]
    : input.notes;
  return {
    componentId: "root",
    rootPath: ".",
    displayName: descriptor.displayName,
    language: descriptor.language,
    framework: descriptor.framework,
    applicationKind: descriptor.applicationKind,
    packageEcosystem: descriptor.packageEcosystem,
    packageManager: input.packageManager,
    stackPluginId: descriptor.stack,
    confidence,
    evidence: detectionEvidence(input, descriptor),
    entrypoints: input.detectedRoutes.length > 0 ? input.detectedRoutes : input.importantFiles.slice(0, 8),
    commands: input.verificationCommands.map((command, index) =>
      makeCommandSpec(`legacy-command-${index + 1}`, command, command, ".")
    ),
    previewTargets: previewTargets(descriptor),
    verificationChecks: verificationChecks(input.verificationCommands, "."),
    importantFiles: input.importantFiles,
    routes: input.detectedRoutes,
    notes: rootNotes,
  };
}

export function createWorkspaceComponentGraphFromLegacyStack(input: LegacyComponentInput): WorkspaceComponentGraph {
  const component = createWorkspaceComponentFromLegacyStack(input);
  return {
    components: [component],
    dependencyGraph: { edges: [] },
    suggestedPrimaryComponentId: component.componentId,
  };
}

export function stackPluginIds(): string[] {
  return legacyDescriptors.map((descriptor) => descriptor.stack);
}

export function stackPluginForProjectStack(stack: ProjectStack): StackPlugin {
  const descriptor = descriptorForStack(stack);
  return {
    id: descriptor.stack,
    displayName: descriptor.displayName,
    languages: [descriptor.language],
    applicationKinds: [descriptor.applicationKind],
    packageEcosystems: [descriptor.packageEcosystem],
    detectFromRequest: async ({ userRequest }) => {
      if (descriptor.requestHints.some((hint) => hint.test(userRequest))) {
        return detectionForDescriptor(descriptor, "high", [
          { filePath: ".", reason: "User request matched this stack plugin.", confidence: "high" },
        ]);
      }
      return null;
    },
    detectFromWorkspace: async () => null,
    scaffold: async () => ({ filesCreated: [], notes: ["Scaffolding is still handled by the legacy workspace bootstrap service."] }),
    analyze: async ({ workspacePath }) => createWorkspaceComponentFromLegacyStack({
      workspacePath,
      stack: descriptor.stack,
      packageManager: null,
      importantFiles: [],
      detectedRoutes: [],
      verificationCommands: [],
      notes: ["Analyzed through the legacy compatibility plugin."],
    }),
    install: async () => [],
    preview: async () => previewTargets(descriptor),
    verify: async ({ component }) => component.verificationChecks,
    agentInstructions: async ({ component }) =>
      `Component ${component.componentId} uses ${descriptor.displayName}. Preserve its conventions unless the task explicitly changes them.`,
    metadata: { compatibility: "legacy-project-stack" },
  };
}

export function stackPlugins(): StackPlugin[] {
  return legacyDescriptors.map((descriptor) => stackPluginForProjectStack(descriptor.stack));
}

export async function resolveStackFromRequestPlugins(userRequest: string): Promise<{
  stack: ProjectStack;
  confidence: "high" | "medium" | "low";
  reason: string;
} | null> {
  for (const plugin of stackPlugins()) {
    const detection = await plugin.detectFromRequest({ userRequest });
    if (detection !== null && detection.stackId !== "unknown") {
      return {
        stack: detection.stackId as ProjectStack,
        confidence: detection.confidence,
        reason: `Request matched stack plugin '${plugin.id}'.`,
      };
    }
  }
  return null;
}
