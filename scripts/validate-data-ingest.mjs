import { mkdir, rm, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  confineDestinationDir,
  DataIngestError,
  resolveWorkspacePath,
  sanitizeRelativeDataPath,
  sanitizeSegment,
  writeUploadedFiles,
} from "../lib/server/ml/data-ingest.ts";


const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const scratch = path.join(root, ".workspace", ".data-ingest-validate");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log("  PASS", name, detail ? "(" + detail + ")" : "");
  } else {
    failed += 1;
    failures.push(name + (detail ? " - " + detail : ""));
    console.log("  FAIL", name, detail ? "(" + detail + ")" : "");
  }
}

function bytes(text) {
  return new TextEncoder().encode(text);
}

async function exists(absPath) {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });

  check("sanitizeSegment strips separators/odd chars", sanitizeSegment("a/b*c") === "a_b_c", sanitizeSegment("a/b*c"));
  check("sanitizeSegment drops traversal", sanitizeSegment("..") === "" && sanitizeSegment(".") === "");
  check("sanitizeSegment strips leading dots", sanitizeSegment(".hidden") === "hidden");

  check("destDir null => data root", JSON.stringify(confineDestinationDir(null)) === JSON.stringify({ dir: "data" }));
  check("destDir data/train ok", JSON.stringify(confineDestinationDir("data/train")) === JSON.stringify({ dir: "data/train" }));
  check("destDir absolute rejected", "error" in confineDestinationDir("/data/train"));
  check("destDir drive-letter rejected", "error" in confineDestinationDir("C:/data"));
  check("destDir traversal rejected", "error" in confineDestinationDir("data/../etc"));
  check("destDir non-data root rejected", "error" in confineDestinationDir("etc/passwd"));

  const slip = sanitizeRelativeDataPath("../evil.txt", "data");
  check("relpath ../ escape skipped", "skip" in slip && slip.skip === "path-escape", JSON.stringify(slip));
  const back = sanitizeRelativeDataPath("..\\..\\evil", "data/train");
  check("relpath backslash traversal skipped", "skip" in back && back.skip === "path-escape", JSON.stringify(back));
  const mac = sanitizeRelativeDataPath("__MACOSX/foo", "data");
  check("relpath __MACOSX skipped", "skip" in mac && mac.skip === "metadata");
  const dot = sanitizeRelativeDataPath("sub/.DS_Store", "data");
  check("relpath dotfile skipped", "skip" in dot && dot.skip === "dotfile");
  const nested = sanitizeRelativeDataPath("train/sub/a.jsonl", "data/mydata");
  check("relpath nested preserved + confined", "rel" in nested && nested.rel === "data/mydata/train/sub/a.jsonl", JSON.stringify(nested));
  const abs = sanitizeRelativeDataPath("/etc/passwd", "data");
  check("relpath absolute is confined under data/", "rel" in abs && abs.rel === "data/etc/passwd", JSON.stringify(abs));
  const drive = sanitizeRelativeDataPath("C:/Windows/x", "data");
  check("relpath drive neutralized + confined", "rel" in drive && drive.rel.startsWith("data/") && !drive.rel.includes(":"), JSON.stringify(drive));

  check("resolveWorkspacePath rejects escape", resolveWorkspacePath(scratch, "../outside.txt") === null);
  check("resolveWorkspacePath allows data/", typeof resolveWorkspacePath(scratch, "data/a.txt") === "string");

  const caps = { maxFileBytes: 1024, maxTotalBytes: 4096, maxFiles: 10 };

  const happy = await writeUploadedFiles({
    files: [
      { name: "a.jsonl", relativePath: "train/a.jsonl", bytes: bytes("a") },
      { name: "b.jsonl", relativePath: "train/sub/b.jsonl", bytes: bytes("bb") },
    ],
    destinationDir: "data/mydata",
    workspacePath: scratch,
    caps,
  });
  check("happy: kind folder", happy.kind === "folder", happy.kind);
  check("happy: primaryPath is dest folder", happy.primaryPath === "data/mydata", happy.primaryPath);
  check("happy: 2 written, 0 skipped", happy.written.length === 2 && happy.skipped.length === 0);
  check("happy: nested file on disk", await exists(path.join(scratch, "data", "mydata", "train", "sub", "b.jsonl")));

  const slipWrite = await writeUploadedFiles({
    files: [
      { name: "ok.txt", relativePath: "ok.txt", bytes: bytes("ok") },
      { name: "evil", relativePath: "../../evil.txt", bytes: bytes("x") },
    ],
    destinationDir: "data/drop",
    workspacePath: scratch,
    caps,
  });
  check("slip: hostile entry skipped", slipWrite.skipped.some((s) => s.reason === "path-escape"), JSON.stringify(slipWrite.skipped));
  check("slip: nothing written above workspace", !(await exists(path.join(root, "evil.txt"))) && !(await exists(path.join(scratch, "..", "evil.txt"))));

  const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]); // "PK\x03\x04" + payload
  const zipWrite = await writeUploadedFiles({
    files: [{ name: "corpus.zip", relativePath: null, bytes: zipBytes }],
    destinationDir: "data/archive",
    workspacePath: scratch,
    caps,
  });
  check("zip: written under data/archive with extension", zipWrite.written[0]?.path === "data/archive/corpus.zip", JSON.stringify(zipWrite.written));
  const storedZip = await readFile(path.join(scratch, "data", "archive", "corpus.zip"));
  check("zip: bytes are verbatim (not extracted)", storedZip.length === zipBytes.length && storedZip[0] === 0x50 && storedZip[1] === 0x4b);

  let threwPerFile = false;
  try {
    await writeUploadedFiles({
      files: [{ name: "big.txt", relativePath: "big.txt", bytes: new Uint8Array(2048) }],
      destinationDir: "data",
      workspacePath: scratch,
      caps,
    });
  } catch (error) {
    threwPerFile = error instanceof DataIngestError;
  }
  check("caps: per-file over limit throws DataIngestError", threwPerFile);

  let threwTotal = false;
  try {
    await writeUploadedFiles({
      files: [
        { name: "x.txt", relativePath: "x.txt", bytes: new Uint8Array(900) },
        { name: "y.txt", relativePath: "y.txt", bytes: new Uint8Array(900) },
        { name: "z.txt", relativePath: "z.txt", bytes: new Uint8Array(900) },
        { name: "w.txt", relativePath: "w.txt", bytes: new Uint8Array(900) },
        { name: "v.txt", relativePath: "v.txt", bytes: new Uint8Array(900) },
      ],
      destinationDir: "data",
      workspacePath: scratch,
      caps,
    });
  } catch (error) {
    threwTotal = error instanceof DataIngestError;
  }
  check("caps: aggregate over limit throws DataIngestError", threwTotal);

  let threwCount = false;
  try {
    const many = [];
    for (let i = 0; i < caps.maxFiles + 1; i += 1) {
      many.push({ name: `f${i}.txt`, relativePath: `f${i}.txt`, bytes: bytes("x") });
    }
    await writeUploadedFiles({ files: many, destinationDir: "data", workspacePath: scratch, caps });
  } catch (error) {
    threwCount = error instanceof DataIngestError;
  }
  check("caps: file-count over limit throws DataIngestError", threwCount);

  let threwAllSkipped = false;
  try {
    await writeUploadedFiles({
      files: [{ name: "evil", relativePath: "../escape", bytes: bytes("x") }],
      destinationDir: "data",
      workspacePath: scratch,
      caps,
    });
  } catch (error) {
    threwAllSkipped = error instanceof DataIngestError;
  }
  check("all-skipped throws DataIngestError", threwAllSkipped);

  await rm(scratch, { recursive: true, force: true });

  console.log("");
  console.log(`Data-ingest validation: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failures:");
    for (const failure of failures) {
      console.log("  -", failure);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
