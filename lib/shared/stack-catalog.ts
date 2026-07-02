import type { ProjectStack } from "@/lib/shared/types";

export type StackCatalogGroup = "Frontend only" | "Node" | "Python" | "R" | "Other";

export interface StackCatalogEntry {
  stack: ProjectStack;
  label: string;
  group: StackCatalogGroup;
  scaffolded: boolean;
  featureFlag?: "ml";
}

export const stackCatalog: StackCatalogEntry[] = [
  { stack: "static-html", label: "Static HTML/CSS/JS (frontend only)", group: "Frontend only", scaffolded: true },
  { stack: "next", label: "Next.js (fullstack React)", group: "Node", scaffolded: true },
  { stack: "vite-react", label: "Vite + React (frontend build)", group: "Node", scaffolded: true },
  { stack: "node-express", label: "Node + Express (server-rendered / API)", group: "Node", scaffolded: true },
  { stack: "node-cli", label: "Node CLI", group: "Node", scaffolded: true },
  { stack: "python-script", label: "Python script", group: "Python", scaffolded: true },
  { stack: "python-ml", label: "Python ML / scientific computing", group: "Python", scaffolded: true, featureFlag: "ml" },
  { stack: "python-flask", label: "Flask (Python web)", group: "Python", scaffolded: true },
  { stack: "python-django", label: "Django (Python web)", group: "Python", scaffolded: true },
  { stack: "r-script", label: "R script / visualization", group: "R", scaffolded: true },
  { stack: "r-shiny", label: "Shiny (R web app)", group: "R", scaffolded: true },
  { stack: "csharp", label: "C# / ASP.NET Core", group: "Other", scaffolded: true },
  { stack: "java", label: "Java", group: "Other", scaffolded: true },
  { stack: "php", label: "PHP / Laravel", group: "Other", scaffolded: true },
  { stack: "ruby", label: "Ruby", group: "Other", scaffolded: true },
  { stack: "go", label: "Go", group: "Other", scaffolded: true },
  { stack: "rust", label: "Rust", group: "Other", scaffolded: true },
];

export const allowedTargetStacks: ProjectStack[] = stackCatalog.map((entry) => entry.stack);

export function isAllowedTargetStack(value: unknown): value is ProjectStack {
  return typeof value === "string" && (allowedTargetStacks as string[]).includes(value);
}

export function stackCatalogEntry(stack: ProjectStack): StackCatalogEntry | null {
  return stackCatalog.find((entry) => entry.stack === stack) ?? null;
}
