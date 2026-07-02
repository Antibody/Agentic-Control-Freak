import { rmSync } from "node:fs";

for (const target of [".data", ".workspace"]) {
  rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
}
