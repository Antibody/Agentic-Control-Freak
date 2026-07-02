export interface SpawnTarget {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export function isWindowsBatchCommand(command: string): boolean {
  const normalizedCommand = command.toLowerCase();
  return normalizedCommand.endsWith(".cmd") || normalizedCommand.endsWith(".bat");
}

export function windowsBatchSpawnTarget(command: string, args: string[]): SpawnTarget {
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", ["call", quoteForCmd(command), ...args.map(quoteForCmd)].join(" ")],
    windowsVerbatimArguments: true,
  };
}

function quoteForCmd(value: string): string {
  if (value.length === 0) {
    return "\"\"";
  }
  const escaped = value.replace(/"/g, "\"\"");
  return /[\s&|<>()^"%]/.test(value) ? `"${escaped}"` : escaped;
}
