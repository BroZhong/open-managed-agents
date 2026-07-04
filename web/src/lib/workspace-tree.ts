import type { WorkspaceFile } from "@/lib/types";

/** A node in the Workspace file tree built from a flat path list. */
export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  children: TreeNode[];
}

/** Build a nested tree from a flat list of workspace-relative file paths. */
export function buildTree(files: WorkspaceFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let node = root;
    segments.forEach((seg, i) => {
      const isLeaf = i === segments.length - 1;
      const path = segments.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === seg && c.isDir !== isLeaf);
      if (!child) {
        child = { name: seg, path, isDir: !isLeaf, children: [] };
        node.children.push(child);
      }
      if (isLeaf) child.size = file.size;
      node = child;
    });
  }
  sortTree(root);
  return root;
}

/** Directories first, then files, each alphabetical. */
export function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  node.children.forEach(sortTree);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Encode each path segment so slashes remain separators. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
