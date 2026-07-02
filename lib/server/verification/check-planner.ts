import type { VerificationCheckSpec } from "@/lib/shared/verification-checks";

function familyForCommand(command: string): VerificationCheckSpec["family"] {
  const normalized = command.toLowerCase();
  if (/\bbuild\b/.test(normalized)) return "build";
  if (/\blint\b/.test(normalized)) return "lint";
  if (/\btypecheck\b|\btsc\b/.test(normalized)) return "typecheck";
  if (/\btest\b|\bpytest\b|\brspec\b/.test(normalized)) return "unit-test";
  if (/\bpy_compile\b|\bphp -l\b|\bruby -c\b|\bjavac\b|\bcargo check\b/.test(normalized)) return "syntax";
  if (/\bhealth\b|\bcurl\b/.test(normalized)) return "http-health";
  return "custom";
}

export function planCommandVerificationChecks(input: {
  componentId: string;
  workspacePath: string;
  commands: string[];
}): VerificationCheckSpec[] {
  return input.commands.map((command, index) => ({
    id: `command-${index + 1}`,
    label: command,
    family: familyForCommand(command),
    required: true,
    command: {
      id: `command-${index + 1}`,
      label: command,
      command,
      args: [],
      cwd: input.workspacePath,
      env: {},
      timeoutMs: 120000,
      allowNetwork: false,
    },
    metadata: {
      componentId: input.componentId,
      source: "verification-command-planner",
    },
  }));
}
