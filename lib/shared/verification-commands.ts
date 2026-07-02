export function isBuildVerificationCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/i.test(command.trim());
}

export function userExplicitlyRequestedBuildVerification(message: string): boolean {
  const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    /\b(?:run|execute|perform|do)\s+(?:the\s+)?(?:production\s+)?build\b/.test(normalized) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/.test(normalized) ||
    /\bbuild\s+(?:verification|check|step|command)\b/.test(normalized) ||
    /\bverify\s+(?:with|using|by running)\s+(?:the\s+)?(?:production\s+)?build\b/.test(normalized) ||
    /\bbuild\b[^.?!\n]{0,100}\bpass(?:es|ing)?\b/.test(normalized) ||
    /\bpass(?:es|ing)?\b[^.?!\n]{0,100}\bbuild\b/.test(normalized)
  );
}

export function filterBuildVerificationCommands(commands: string[], options: { allowBuild: boolean }): string[] {
  return options.allowBuild ? commands : commands.filter((command) => !isBuildVerificationCommand(command));
}
