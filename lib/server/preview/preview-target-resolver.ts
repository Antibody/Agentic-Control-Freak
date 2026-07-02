import type { PreviewCommand } from "@/lib/server/preview-manager";
import { detectPreviewCommand } from "@/lib/server/preview-manager";
import type { PreviewTargetSpec } from "@/lib/shared/preview-targets";

function surfaceForCommand(command: PreviewCommand): PreviewTargetSpec["surface"] {
  if (!command.previewable) {
    return "none";
  }
  if (command.appType === "python-script" || command.appType === "r-script") {
    return "generated-report";
  }
  if (command.appType === "static-html" || command.serverReloadMode === "static") {
    return "static-files";
  }
  if (command.appType === "node-cli") {
    return "cli-output";
  }
  return "browser";
}

export async function resolvePreviewTargets(input: {
  workspacePath: string;
  port: number;
  host: string;
}): Promise<PreviewTargetSpec[]> {
  const command = await detectPreviewCommand(input.workspacePath, input.port, input.host);
  return [
    {
      id: "primary-preview",
      label: `${command.appType} preview`,
      surface: surfaceForCommand(command),
      command: {
        id: "primary-preview-command",
        label: command.renderedCommand,
        command: command.command,
        args: command.args,
        cwd: input.workspacePath,
        env: {
          HOST: input.host,
          PORT: String(input.port),
        },
        timeoutMs: 120000,
        allowNetwork: false,
      },
      portEnvName: command.previewable ? "PORT" : null,
      healthPaths: command.previewable ? ["/"] : [],
      staticRoot: command.appType === "static-html" ? input.workspacePath : null,
      metadata: {
        appType: command.appType,
        packageManager: command.packageManager ?? "",
        needsDependencyInstall: String(command.needsDependencyInstall),
        serverReloadMode: command.serverReloadMode,
      },
    },
  ];
}
