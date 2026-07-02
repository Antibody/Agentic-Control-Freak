import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const scratch = path.join(root, ".workspace", ".preview-smoke");

function spawnTarget(command, args) {
  if (process.platform === "win32" && (command.toLowerCase().endsWith(".cmd") || command.toLowerCase().endsWith(".bat"))) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", ["call", quoteForCmd(command), ...args.map(quoteForCmd)].join(" ")],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args };
}

function quoteForCmd(value) {
  if (value.length === 0) {
    return "\"\"";
  }
  const escaped = value.replace(/"/g, "\"\"");
  return /[\s&|<>()^"%]/.test(value) ? `"${escaped}"` : escaped;
}

function run(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const target = spawnTarget(command, args);
    const child = spawn(target.command, target.args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: target.windowsVerbatimArguments,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function probe(url, expectedText) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      if (response.ok && text.includes(expectedText)) {
        return;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview did not become healthy: ${url}`);
}

async function main() {
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });

  const nodeDir = path.join(scratch, "node-app");
  await mkdir(nodeDir, { recursive: true });
  await writeFile(path.join(nodeDir, "package.json"), JSON.stringify({
    private: true,
    scripts: { dev: "node server.js" },
  }, null, 2));
  await writeFile(path.join(nodeDir, "server.js"), `
const http = require("http");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3201);
http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<h1>Node preview works</h1>");
}).listen(port, host);
`);

  const nodeCommand = spawnTarget(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"]);
  const nodeProcess = spawn(nodeCommand.command, nodeCommand.args, {
    cwd: nodeDir,
    env: { ...process.env, HOST: "127.0.0.1", PORT: "3201" },
    shell: false,
    stdio: "ignore",
    windowsVerbatimArguments: nodeCommand.windowsVerbatimArguments,
    windowsHide: true,
  });
  await probe("http://127.0.0.1:3201", "Node preview works");
  nodeProcess.kill();

  const nextDir = path.join(scratch, "next-app");
  await mkdir(path.join(nextDir, "app"), { recursive: true });
  await writeFile(path.join(nextDir, "package.json"), JSON.stringify({
    private: true,
    scripts: { dev: "next dev" },
    dependencies: {
      next: "16.2.6",
      react: "latest",
      "react-dom": "latest",
    },
    devDependencies: {},
  }, null, 2));
  await writeFile(path.join(nextDir, "app", "layout.jsx"), `
export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}
`);
  await writeFile(path.join(nextDir, "app", "page.jsx"), `
export default function Page() {
  return <main><h1>Next preview works</h1></main>;
}
`);
  await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"], nextDir);
  const nextCommand = spawnTarget(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--", "-H", "127.0.0.1", "-p", "3202"]);
  const nextProcess = spawn(nextCommand.command, nextCommand.args, {
    cwd: nextDir,
    env: { ...process.env, HOST: "127.0.0.1", PORT: "3202" },
    shell: false,
    stdio: "ignore",
    windowsVerbatimArguments: nextCommand.windowsVerbatimArguments,
    windowsHide: true,
  });
  await probe("http://127.0.0.1:3202", "Next preview works");
  nextProcess.kill();

  console.log("preview smoke passed: node and next apps served successfully");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
