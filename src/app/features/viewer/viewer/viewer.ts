import {
  Component,
  DestroyRef,
  OnInit,
  ViewChild,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';

import { GithubService } from '../../../core/services/github';
import { LayoutService } from '../../../core/services/layout';
import {
  ColorMode,
  DEFAULT_DISPLAY_OPTIONS,
  DEFAULT_LAYOUT_PARAMS,
  DiffStatus,
  DisplayOptions,
  LayoutParams,
  LoadingState,
  TreeStructure,
} from '../../../shared/models/tree-node.model';
import { BranchesEvent, ControlsPanel, RepoSubmitEvent } from '../controls-panel/controls-panel';
import { ThreeCanvas } from '../three-canvas/three-canvas';

@Component({
  selector: 'app-viewer',
  imports: [ControlsPanel, ThreeCanvas],
  templateUrl: './viewer.html',
  styleUrl: './viewer.scss',
})
export class Viewer implements OnInit {
  @ViewChild(ThreeCanvas) private threeCanvas!: ThreeCanvas;

  resetCamera = false;
  autoOrbit = false;
  display: DisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS };
  extColors: { ext: string; label: string; color: string; count: number }[] = [];
  status = signal<LoadingState>('idle');
  initialRepo = '';
  initialQuery = '';
  initialColorMode: ColorMode = 'type';
  initialShow = '';
  initialVs = '';
  initialSphereD = DEFAULT_LAYOUT_PARAMS.sphereD;
  showRef = '';
  vsRef = '';

  get result() {
    return this.layout.result;
  }
  get error() {
    return this.layout.error;
  }

  get maxFileSize(): number {
    const nodes = this.layout.result()?.nodes;
    if (!nodes) return 0;
    return Math.max(0, ...nodes.filter((n) => n.isFile).map((n) => n.fileSize ?? 0));
  }

  get maxDepth(): number {
    const nodes = this.layout.result()?.nodes;
    if (!nodes) return 0;
    return Math.max(0, ...nodes.map((n) => (n.path === '' ? 0 : n.path.split('/').length)));
  }

  get isDiff(): boolean {
    return this.layout.result()?.isDiff ?? false;
  }

  get diffStats(): { added: number; modified: number; deleted: number } | null {
    const result = this.layout.result();
    if (!result?.isDiff) return null;
    const files = result.nodes.filter((n) => n.isFile);
    return {
      added: files.filter((n) => n.diffStatus === 'added').length,
      modified: files.filter((n) => n.diffStatus === 'modified').length,
      deleted: files.filter((n) => n.diffStatus === 'deleted').length,
    };
  }

  private rawRoot: TreeStructure | null = null;
  repoName = '';
  headBranch = '';
  private headRepoName = '';
  private vsLinkRef = '';
  private prNumber: number | null = null;
  private currentOwner = '';
  private currentRepo = '';
  private isDiffMode = false;
  private params: LayoutParams = { ...DEFAULT_LAYOUT_PARAMS };
  private destroyRef = inject(DestroyRef);

  constructor(
    private github: GithubService,
    private layout: LayoutService,
    private router: Router,
    private route: ActivatedRoute,
  ) {
    // When layout finishes (result or error changes), go back to idle
    effect(() => {
      this.layout.result();
      this.layout.error();
      if (untracked(this.status) !== 'idle') this.status.set('idle');
    });
  }

  ngOnInit(): void {
    this.route.params.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const { owner, repo } = params;
      if (owner && repo) {
        this.initialRepo = `${owner}/${repo}`;
        const q = this.route.snapshot.queryParams['q'] ?? '';
        const color = this.route.snapshot.queryParams['color'] ?? '';
        const pr = this.route.snapshot.queryParams['pr'] ?? '';
        const show = this.route.snapshot.queryParams['show'] ?? '';
        const vs = this.route.snapshot.queryParams['vs'] ?? '';
        const sphereD = parseFloat(this.route.snapshot.queryParams['sphereD'] ?? '');
        this.initialQuery = q;
        if (!isNaN(sphereD) && sphereD > 0) {
          this.initialSphereD = sphereD;
          this.params = { ...this.params, sphereD };
        }
        this.initialColorMode = (['type', 'depth', 'size'] as ColorMode[]).includes(
          color as ColorMode,
        )
          ? (color as ColorMode)
          : 'type';
        this.display = {
          ...DEFAULT_DISPLAY_OPTIONS,
          pathQuery: q,
          colorMode: this.initialColorMode,
        };

        if (pr) {
          const prNum = Number(pr);
          setTimeout(async () => {
            this.status.set('fetching');
            try {
              const prData = await this.github.fetchPR(owner, repo, prNum);
              this.prNumber = prNum;
              this.initialShow = prData.headRef;
              this.initialVs = prData.baseRef;
              this.showRef = prData.headRef;
              this.vsRef = prData.baseRef;
              await this.loadBranches(
                owner,
                repo,
                prData.headSha,
                prData.baseSha,
                prData.headRef,
                prData.baseRef,
                prData.headRepoName,
              );
            } catch (e) {
              this.layout.error.set(e instanceof Error ? e.message : String(e));
              this.status.set('idle');
            }
          });
        } else {
          this.initialShow = show;
          this.initialVs = vs;
          this.showRef = show;
          this.vsRef = vs;
          setTimeout(() => this.loadBranches(owner, repo, show, vs));
        }
      }
    });
  }

  async onRepoSubmit(event: RepoSubmitEvent): Promise<void> {
    this.layout.error.set(null);
    const parsed = this.github.parseRepoUrl(event.url);
    if (!parsed) {
      this.layout.error.set('Invalid GitHub URL');
      return;
    }

    this.showRef = '';
    this.vsRef = '';
    this.initialShow = '';
    this.initialVs = '';
    this.repoName = '';

    if (parsed.prNumber) {
      this.status.set('fetching');
      try {
        const pr = await this.github.fetchPR(parsed.owner, parsed.repo, parsed.prNumber);
        this.prNumber = parsed.prNumber;
        this.showRef = pr.headRef;
        this.vsRef = pr.baseRef;
        this.initialShow = pr.headRef;
        this.initialVs = pr.baseRef;
        this.router.navigate([parsed.owner, parsed.repo], {
          queryParams: { pr: parsed.prNumber },
        });
        await this.loadBranches(
          parsed.owner,
          parsed.repo,
          pr.headSha,
          pr.baseSha,
          pr.headRef,
          pr.baseRef,
          pr.headRepoName,
        );
      } catch (e) {
        this.layout.error.set(e instanceof Error ? e.message : String(e));
        this.status.set('idle');
      }
    } else {
      this.router.navigate([parsed.owner, parsed.repo]);
      await this.loadBranches(parsed.owner, parsed.repo, '', '');
    }
  }

  async onBranchesChange(event: BranchesEvent): Promise<void> {
    this.prNumber = null;
    this.showRef = event.show;
    this.vsRef = event.vs;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        pr: null,
        show: event.show || null,
        vs: event.vs || null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    await this.loadBranches(this.currentOwner, this.currentRepo, event.show, event.vs);
  }

  private async loadBranches(
    owner: string,
    repo: string,
    showRef: string,
    vsRef: string,
    linkHeadRef?: string,
    linkBaseRef?: string,
    linkHeadRepoName?: string,
  ): Promise<void> {
    this.currentOwner = owner;
    this.currentRepo = repo;
    this.status.set('fetching');
    try {
      const { tree: headTree, ref: resolvedShow } = await this.github.fetchTree(
        owner,
        repo,
        showRef || undefined,
      );
      this.headBranch = linkHeadRef || resolvedShow;
      this.headRepoName = linkHeadRepoName || `${owner}/${repo}`;
      this.vsLinkRef = linkBaseRef ?? vsRef;
      this.repoName = `${owner}/${repo}`;

      if (vsRef.trim()) {
        this.status.set('fetching-base');
        const { tree: baseTree } = await this.github.fetchTree(owner, repo, vsRef);
        this.rawRoot = this.computeDiff(headTree, baseTree);
        this.isDiffMode = true;
      } else {
        this.rawRoot = headTree;
        this.isDiffMode = false;
      }

      // Sync color mode with diff state
      if (this.isDiffMode) {
        this.display = { ...this.display, colorMode: 'diff' };
      } else if (this.display.colorMode === 'diff') {
        this.display = { ...this.display, colorMode: 'type' };
      }

      this.resetCamera = true;
      this.scheduleLayout();
    } catch (e) {
      this.layout.error.set(e instanceof Error ? e.message : String(e));
      this.status.set('idle');
    }
  }

  // ---------------------------------------------------------------------------
  // Diff computation
  // ---------------------------------------------------------------------------

  private computeDiff(head: TreeStructure, base: TreeStructure): TreeStructure {
    // Step 1: flatten both trees to path → node maps
    const headMap = new Map<string, TreeStructure>();
    const baseMap = new Map<string, TreeStructure>();
    this.flattenTree(head, headMap);
    this.flattenTree(base, baseMap);

    // Step 2: determine per-path diff status
    const statusMap = new Map<string, DiffStatus>();
    for (const [path, node] of headMap) {
      const baseNode = baseMap.get(path);
      if (!baseNode) {
        statusMap.set(path, 'added');
      } else if (node.sha && baseNode.sha && node.sha === baseNode.sha) {
        statusMap.set(path, 'unchanged');
      } else {
        statusMap.set(path, 'modified');
      }
    }
    for (const path of baseMap.keys()) {
      if (!headMap.has(path)) statusMap.set(path, 'deleted');
    }

    // Step 3: build merged tree starting from head, inserting deleted nodes
    const merged = this.cloneWithStatus(head, statusMap);

    // Insert deleted nodes from base (including their ancestor folders)
    for (const [path, baseNode] of baseMap) {
      if (statusMap.get(path) === 'deleted') {
        this.insertDeletedNode(merged, path, baseNode, baseMap, statusMap);
      }
    }

    // Step 4: bottom-up pass — propagate diff status to folders, recompute subtreeBytes
    this.propagateFolderStatus(merged);

    return merged;
  }

  private flattenTree(node: TreeStructure, map: Map<string, TreeStructure>): void {
    if (node.path !== '') map.set(node.path, node);
    for (const child of node.children) this.flattenTree(child, map);
  }

  private cloneWithStatus(node: TreeStructure, statusMap: Map<string, DiffStatus>): TreeStructure {
    return {
      ...node,
      diffStatus: statusMap.get(node.path),
      children: node.children.map((c) => this.cloneWithStatus(c, statusMap)),
    };
  }

  private insertDeletedNode(
    mergedRoot: TreeStructure,
    path: string,
    baseNode: TreeStructure,
    baseMap: Map<string, TreeStructure>,
    statusMap: Map<string, DiffStatus>,
  ): void {
    const parts = path.split('/');
    let cur = mergedRoot;

    // Walk/create ancestor folders
    for (let i = 0; i < parts.length - 1; i++) {
      const folderPath = parts.slice(0, i + 1).join('/');
      let child = cur.children.find((c) => c.path === folderPath);
      if (!child) {
        const baseFolder = baseMap.get(folderPath);
        child = {
          path: folderPath,
          isFile: false,
          subtreeBytes: baseFolder?.subtreeBytes ?? 0,
          diffStatus: 'deleted',
          children: [],
        };
        cur.children.push(child);
        statusMap.set(folderPath, 'deleted');
      }
      cur = child;
    }

    // Insert the deleted leaf if not already present
    const alreadyPresent = cur.children.some((c) => c.path === path);
    if (!alreadyPresent) {
      cur.children.push({
        path: baseNode.path,
        isFile: baseNode.isFile,
        fileSize: baseNode.fileSize,
        subtreeBytes: baseNode.subtreeBytes,
        sha: baseNode.sha,
        diffStatus: 'deleted',
        children: baseNode.isFile ? [] : this.cloneDeletedSubtree(baseNode, statusMap),
      });
    }
  }

  private cloneDeletedSubtree(
    node: TreeStructure,
    statusMap: Map<string, DiffStatus>,
  ): TreeStructure[] {
    return node.children.map((c) => {
      statusMap.set(c.path, 'deleted');
      return {
        ...c,
        diffStatus: 'deleted' as DiffStatus,
        children: this.cloneDeletedSubtree(c, statusMap),
      };
    });
  }

  private propagateFolderStatus(node: TreeStructure): void {
    if (node.isFile) return;
    for (const child of node.children) this.propagateFolderStatus(child);

    // Recompute subtreeBytes
    node.subtreeBytes = node.children.reduce((s, c) => s + c.subtreeBytes, 0);

    // Propagate diff status upward
    if (node.diffStatus !== 'deleted' && node.diffStatus !== 'added') {
      const hasChange = node.children.some((c) => c.diffStatus !== 'unchanged');
      if (hasChange) node.diffStatus = 'modified';
      else node.diffStatus = 'unchanged';
    }
  }

  // ---------------------------------------------------------------------------

  onDisplayChange(display: DisplayOptions): void {
    this.display = display;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q: display.pathQuery || null,
        color: display.colorMode !== 'type' ? display.colorMode : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  onCameraReset(): void {
    this.threeCanvas.resetToDefaultCamera();
  }

  onSnapshot(): void {
    const filename = this.repoName
      ? `${this.repoName.replace('/', '-')}-snapshot.png`
      : 'gitcoral-snapshot.png';
    this.threeCanvas.takeSnapshot(filename);
  }

  onAutoOrbitToggle(): void {
    this.autoOrbit = !this.autoOrbit;
  }

  onHome(): void {
    this.rawRoot = null;
    this.repoName = '';
    this.headBranch = '';
    this.headRepoName = '';
    this.vsLinkRef = '';
    this.prNumber = null;
    this.initialRepo = '';
    this.extColors = [];
    this.showRef = '';
    this.vsRef = '';
    this.isDiffMode = false;
    this.currentOwner = '';
    this.currentRepo = '';
    this.layout.result.set(null);
    this.layout.error.set(null);
    this.router.navigate(['']);
  }

  onParamsChange(params: LayoutParams): void {
    this.params = params;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        sphereD: params.sphereD !== DEFAULT_LAYOUT_PARAMS.sphereD ? params.sphereD : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    if (this.rawRoot) {
      this.resetCamera = false;
      this.scheduleLayout();
    }
  }

  private scheduleLayout(): void {
    if (!this.rawRoot) return;
    this.status.set('computing');
    this.layout.schedule(
      this.rawRoot,
      this.params,
      this.repoName,
      this.headRepoName,
      this.headBranch,
      this.vsLinkRef,
      this.isDiffMode,
      this.prNumber,
    );
  }
}
