import { Injectable } from '@angular/core';
import { TreeStructure } from '../../shared/models/tree-node.model';

interface GithubEntry {
  path: string;
  type: 'tree' | 'blob';
  size?: number;
}

interface GithubRepoMeta   { default_branch: string }
interface GithubCommit     { commit: { tree: { sha: string } } }
interface GithubTreeResult { tree: GithubEntry[]; truncated: boolean }

interface InternalNode {
  path: string;
  isFile: boolean;
  fileSize: number;
  children: Map<string, InternalNode>;
  subtreeBytes: number;
}

@Injectable({ providedIn: 'root' })
export class GithubService {

  private readonly BASE = 'https://api.github.com';
  private readonly HEADERS: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'gitcoral',
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

    // Short form: owner/repo
    const short = s.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (short) return { owner: short[1], repo: short[2] };

    return null;
  }

  async fetchTree(owner: string, repo: string, token?: string): Promise<TreeStructure> {
    const headers = token
      ? { ...this.HEADERS, Authorization: `Bearer ${token}` }
      : { ...this.HEADERS };

    // Step 1: get default branch
    const meta   = await this.get<GithubRepoMeta>(`${this.BASE}/repos/${owner}/${repo}`, headers);
    const branch = meta.default_branch ?? 'main';

    // Step 2: get HEAD commit tree SHA
    const commit  = await this.get<GithubCommit>(
      `${this.BASE}/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
      headers,
    );
    const treeSha = commit.commit.tree.sha;
    if (!treeSha) throw new Error('Could not resolve tree SHA');

    // Step 3: fetch full recursive tree
    const treeData = await this.get<GithubTreeResult>(
      `${this.BASE}/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
      headers,
    );
    const entries = treeData.tree ?? [];

    // Step 4: build internal tree structure
    const root = this.makeNode('', false);
    for (const entry of entries) {
      if (entry.type === 'tree') {
        this.ensurePath(root, entry.path, false, 0);
      } else if (entry.type === 'blob') {
        this.ensurePath(root, entry.path, true, entry.size ?? 0);
      }
    }

    // Step 5: compute subtree file counts and byte totals bottom-up
    this.computeSubtreeStats(root);

    // Step 6: flatten to TreeNode (xyz/nodeSize/connectionWidth set to 0 — layout fills them)
    return this.toTreeNode(root);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async get<T>(url: string, headers: Record<string, string>): Promise<T> {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private makeNode(path: string, isFile: boolean, fileSize = 0): InternalNode {
    return { path, isFile, fileSize, children: new Map(), subtreeBytes: 0 };
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

  private computeSubtreeStats(root: InternalNode): void {
    // Collect nodes pre-order, process in reverse = post-order (children before parents)
    const order: InternalNode[] = [];
    const stack: InternalNode[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      order.push(n);
      for (const child of n.children.values()) stack.push(child);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      if (n.isFile) {
        n.subtreeBytes = n.fileSize;
      } else {
        let bytes = 0;
        for (const child of n.children.values()) bytes += child.subtreeBytes;
        n.subtreeBytes = bytes;
      }
    }
  }

  private toTreeNode(root: InternalNode): TreeStructure {
    // Collect nodes pre-order, build TreeStructure objects in reverse = post-order
    const order: InternalNode[] = [];
    const stack: InternalNode[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      order.push(n);
      for (const child of n.children.values()) stack.push(child);
    }
    const built = new Map<InternalNode, TreeStructure>();
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      built.set(n, {
        path: n.path,
        isFile: n.isFile,
        fileSize: n.isFile ? n.fileSize : undefined,
        subtreeBytes: n.subtreeBytes,
        children: [...n.children.values()].map(c => built.get(c)!),
      });
    }
    return built.get(root)!;
  }
}
