import type { CodeChangeKind, SessionChangedFile } from "@/lib/shared/types";
import { isGeneratedPreviewArtifact } from "@/lib/shared/stack-capabilities";

export interface ParsedDiffStats {
  additions: number;
  deletions: number;
  hunks: number;
  binary: boolean;
}

export interface DiffTreeNode {
  id: string;
  name: string;
  path: string;
  kind: "directory" | "file";
  children: DiffTreeNode[];
  file: SessionChangedFile | null;
  additions: number;
  deletions: number;
  changeKind: CodeChangeKind | "mixed";
}

export function parseUnifiedDiffStats(diff: string): ParsedDiffStats {
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  let binary = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      hunks += 1;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions, hunks, binary };
}

export function compactDirectoryTree(node: DiffTreeNode): DiffTreeNode {
  if (node.kind === "file") return node;
  node.children = node.children.map(compactDirectoryTree);
  while (node.children.length === 1 && node.children[0]?.kind === "directory") {
    const child = node.children[0];
    node.name = node.name.length === 0 ? child.name : `${node.name}/${child.name}`;
    node.path = child.path;
    node.children = child.children;
    node.additions = child.additions;
    node.deletions = child.deletions;
    node.changeKind = child.changeKind;
  }
  return node;
}

function mergeKind(a: CodeChangeKind | "mixed", b: CodeChangeKind | "mixed"): CodeChangeKind | "mixed" {
  return a === b ? a : "mixed";
}

export function buildDiffTree(files: SessionChangedFile[]): DiffTreeNode {
  const root: DiffTreeNode = {
    id: "root",
    name: "",
    path: "",
    kind: "directory",
    children: [],
    file: null,
    additions: 0,
    deletions: 0,
    changeKind: files[0]?.changeKind ?? "mixed",
  };
  const directoryByPath = new Map<string, DiffTreeNode>([["", root]]);
  const visibleFiles = files.filter((file) => !isGeneratedPreviewArtifact(file.filePath));
  for (const file of visibleFiles) {
    const parts = file.filePath.split("/").filter((part) => part.length > 0);
    let parent = root;
    let currentPath = "";
    for (const part of parts.slice(0, -1)) {
      currentPath = currentPath.length === 0 ? part : `${currentPath}/${part}`;
      let dir = directoryByPath.get(currentPath);
      if (dir === undefined) {
        dir = {
          id: `dir:${currentPath}`,
          name: part,
          path: currentPath,
          kind: "directory",
          children: [],
          file: null,
          additions: 0,
          deletions: 0,
          changeKind: file.changeKind,
        };
        directoryByPath.set(currentPath, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    const fileNode: DiffTreeNode = {
      id: `file:${file.filePath}`,
      name: parts.at(-1) ?? file.filePath,
      path: file.filePath,
      kind: "file",
      children: [],
      file,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      changeKind: file.changeKind,
    };
    parent.children.push(fileNode);
  }
  const accumulate = (node: DiffTreeNode): void => {
    if (node.kind === "file") return;
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.additions = 0;
    node.deletions = 0;
    let kind: CodeChangeKind | "mixed" | null = null;
    for (const child of node.children) {
      accumulate(child);
      node.additions += child.additions;
      node.deletions += child.deletions;
      kind = kind === null ? child.changeKind : mergeKind(kind, child.changeKind);
    }
    node.changeKind = kind ?? node.changeKind;
  };
  accumulate(root);
  root.children = root.children.map(compactDirectoryTree);
  accumulate(root);
  return root;
}
