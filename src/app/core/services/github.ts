import { Injectable } from '@angular/core';
import { TreeNode } from '../../shared/models/tree-node.model';

interface GithubEntry {
  path: string;
  type: 'tree' | 'blob';
  size?: number;
}

interface InternalNode {
  path: string;
  isFile: boolean;
  fileSize: number;
  children: Map<string, InternalNode>;
  subtreeFiles: number;
}

@Injectable({ providedIn: 'root' })
export class GithubService {

  private readonly BASE = 'https://api.github.com';
  private readonly HEADERS: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'code-orb',
  };

  parseRepoUrl(url: string): { owner: string; repo: string } | null {
    const s = url.trim().replace(/\/$/, '');

    // SSH: git@github.com:owner/repo.git
    const ssh = s.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (ssh) return { owner: ssh[1], repo: ssh[2] };

    // HTTPS: https://github.com/owner/repo
    if (s.includes('github.com')) {
      const parsed = new URL(s.startsWith('http') ? s : `https://${s}`);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
    }

    return null;
  }

  async fetchTree(owner: string, repo: string, token?: string): Promise<TreeNode> {
    const headers = token
      ? { ...this.HEADERS, Authorization: `Bearer ${token}` }
      : { ...this.HEADERS };

    // Step 1: get default branch
    const meta = await this.get(`${this.BASE}/repos/${owner}/${repo}`, headers);
    const branch: string = meta.default_branch ?? 'main';

    // Step 2: get HEAD commit tree SHA
    const commit = await this.get(
      `${this.BASE}/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
      headers,
    );
    const treeSha: string = commit?.commit?.tree?.sha;
    if (!treeSha) throw new Error('Could not resolve tree SHA');

    // Step 3: fetch full recursive tree
    const treeData = await this.get(
      `${this.BASE}/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
      headers,
    );
    const entries: GithubEntry[] = treeData.tree ?? [];

    // Step 4: build internal tree structure
    const root = this.makeNode('', false);
    for (const entry of entries) {
      if (entry.type === 'tree') {
        this.ensurePath(root, entry.path, false, 0);
      } else if (entry.type === 'blob') {
        this.ensurePath(root, entry.path, true, entry.size ?? 0);
      }
    }

    // Step 5: compute subtree file counts bottom-up
    this.computeSubtreeFiles(root);

    // Step 6: flatten to TreeNode (xyz/nodeSize/connectionWidth set to 0 — layout fills them)
    return this.toTreeNode(root);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async get(url: string, headers: Record<string, string>): Promise<any> {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${body}`);
    }
    return res.json();
  }

  private makeNode(path: string, isFile: boolean, fileSize = 0): InternalNode {
    return { path, isFile, fileSize, children: new Map(), subtreeFiles: 0 };
  }

  private ensurePath(
    root: InternalNode,
    relPath: string,
    isFile: boolean,
    fileSize: number,
  ): void {
    const parts = relPath.split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (!cur.children.has(part)) {
        const childPath = cur.path ? `${cur.path}/${part}` : part;
        cur.children.set(part, this.makeNode(childPath, isLast && isFile, isLast ? fileSize : 0));
      }
      const child = cur.children.get(part)!;
      // A path may appear as tree before its blob entry — update if needed
      if (isLast && isFile) {
        child.isFile = true;
        child.fileSize = fileSize;
      }
      cur = child;
    }
  }

  private computeSubtreeFiles(node: InternalNode): number {
    if (node.isFile) { node.subtreeFiles = 1; return 1; }
    let total = 0;
    for (const child of node.children.values()) {
      total += this.computeSubtreeFiles(child);
    }
    node.subtreeFiles = Math.max(1, total);
    return node.subtreeFiles;
  }

  private toTreeNode(node: InternalNode): TreeNode {
    return {
      path: node.path,
      isFile: node.isFile,
      x: 0, y: 0, z: 0,
      connectionWidth: 0,
      nodeSize: 0,
      fileSize: node.isFile ? node.fileSize : undefined,
      subtreeFiles: node.subtreeFiles,
      children: [...node.children.values()].map(c => this.toTreeNode(c)),
    };
  }
}
