import type { JsonObject } from "@/lib/shared/types";
import type { CommandSpec } from "@/lib/shared/stack-descriptors";

export type PreviewSurface =
  | "browser"
  | "static-files"
  | "http-api"
  | "cli-output"
  | "generated-report"
  | "none";

export interface PreviewTargetSpec {
  id: string;
  label: string;
  surface: PreviewSurface;
  command: CommandSpec | null;
  portEnvName: string | null;
  healthPaths: string[];
  staticRoot: string | null;
  metadata: JsonObject;
}
