import {
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { DEFAULT_DISPLAY_OPTIONS, DisplayOptions, LayoutResult, TreeNode } from '../../../shared/models/tree-node.model';

// Plotly is loaded as a side-effect import; types come from @types/plotly.js-dist-min
import * as Plotly from 'plotly.js-dist-min';

function extColor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) return 'hsl(220,15%,55%)';
  const ext = path.slice(dot + 1).toLowerCase();
  let h = 0;
  for (let i = 0; i < ext.length; i++) h = (Math.imul(31, h) + ext.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue},65%,62%)`;
}

function folderColor(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (Math.imul(31, h) + path.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360},35%,42%)`;
}

@Component({
  selector: 'app-plotly-canvas',
  templateUrl: './plotly-canvas.html',
  styleUrl: './plotly-canvas.scss',
})
export class PlotlyCanvas implements OnInit, OnChanges, OnDestroy {

  @Input() result: LayoutResult | null = null;
  @Input() resetCamera = false;
  @Input() display: DisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS };
  @ViewChild('container', { static: true }) containerRef!: ElementRef<HTMLDivElement>;

  private get el(): HTMLDivElement {
    return this.containerRef.nativeElement;
  }

  private resizeObserver!: ResizeObserver;
  private focusPath: string | null = null;

  ngOnInit(): void {
    this.initEmpty();
    this.resizeObserver = new ResizeObserver(() => {
      Plotly.Plots.resize(this.el);
    });
    this.resizeObserver.observe(this.el);
    let markerClicked = false;
    let mouseDownX = 0, mouseDownY = 0;

    this.el.addEventListener('mousedown', (e: MouseEvent) => {
      mouseDownX = e.clientX;
      mouseDownY = e.clientY;
    });

    (this.el as any).on('plotly_click', (data: any) => {
      const pt = data?.points?.[0];
      const clicked = pt?.customdata as string | undefined;
      if (clicked === undefined || clicked === null) return;
      markerClicked = true;
      this.focusPath = this.focusPath === clicked ? null : clicked;
      if (this.result) setTimeout(() => this.render(this.result!, true));
    });

    this.el.addEventListener('click', (e: MouseEvent) => {
      const dx = e.clientX - mouseDownX;
      const dy = e.clientY - mouseDownY;
      const isDrag = Math.sqrt(dx * dx + dy * dy) > 4;
      if (!isDrag && !markerClicked && this.focusPath !== null) {
        this.focusPath = null;
        if (this.result) setTimeout(() => this.render(this.result!, true));
      }
      markerClicked = false;
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['result'] || changes['display']) && this.result) {
      if (changes['result']) this.focusPath = null;
      const onlyDisplayChanged = !changes['result'] && !!changes['display'];
      const preserveCamera = onlyDisplayChanged || (!!changes['result']?.previousValue && !this.resetCamera);
      this.render(this.result, preserveCamera);
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver.disconnect();
    Plotly.purge(this.el);
  }

  // Returns which paths are "in focus": clicked node + its ancestors + all descendants
  private buildFocusSet(nodes: TreeNode[], focusPath: string): Set<string> {
    const set = new Set<string>();
    set.add(focusPath);
    // Ancestors
    const parts = focusPath.split('/');
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    set.add(''); // root always in focus
    // All descendants (any node whose path starts with focusPath + '/')
    const prefix = focusPath ? focusPath + '/' : '';
    for (const n of nodes) {
      if (prefix === '' || n.path.startsWith(prefix)) set.add(n.path);
    }
    return set;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private initEmpty(): void {
    Plotly.newPlot(this.el, [], this.buildLayout(''), {
      scrollZoom: true,
      displaylogo: false,
      responsive: true,
    });
  }

  private render(result: LayoutResult, preserveCamera = false): void {
    const traces = this.buildTraces(result.nodes);
    Plotly.react(this.el, traces, this.buildLayout(result.repoName, preserveCamera), {
      scrollZoom: true,
      displaylogo: false,
      responsive: true,
    });
  }

  private buildTraces(nodes: TreeNode[]): Plotly.Data[] {
    const allFolders = nodes.filter(n => !n.isFile);
    const folders    = this.display.showFolders ? allFolders : [];
    const files      = this.display.showFiles   ? nodes.filter(n => n.isFile) : [];

    const focusSet = this.focusPath ? this.buildFocusSet(nodes, this.focusPath) : null;
    const DIM = 0.08; // alpha for out-of-focus nodes
    const inFocus = (path: string) => !focusSet || focusSet.has(path);

    // O(1) parent lookup by path
    const nodeByPath = new Map<string, TreeNode>(nodes.map(n => [n.path, n]));

    // Accumulate total file bytes up through each folder's ancestor chain
    const subtreeSize = new Map<string, number>();
    for (const file of nodes.filter(n => n.isFile)) {
      const bytes = file.fileSize ?? 0;
      const parts = file.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const folderPath = parts.slice(0, i).join('/');
        subtreeSize.set(folderPath, (subtreeSize.get(folderPath) ?? 0) + bytes);
      }
      subtreeSize.set('', (subtreeSize.get('') ?? 0) + bytes); // root
    }

    // Group folder edges by (width bucket × hue bucket × depth bucket) for batched line rendering
    // Edges are built from allFolders so connectors are independent of folder visibility
    const DEPTH_BUCKETS = 5;
    const HUE_BUCKETS   = 8;
    const zValues = allFolders.map(n => n.z);
    const zMin = Math.min(...zValues, 0);
    const zMax = Math.max(...zValues, 1);
    const zRange = zMax - zMin || 1;

    // Width range: compress layout's 2–12px down to 1–5px
    const W_IN_MIN = 2, W_IN_MAX = 12, W_OUT_MIN = 1, W_OUT_MAX = 5;

    function folderHue(path: string): number {
      let h = 0;
      for (let i = 0; i < path.length; i++) h = (Math.imul(31, h) + path.charCodeAt(i)) | 0;
      return Math.abs(h) % 360;
    }

    const edgeGroups = new Map<string, { x: number[]; y: number[]; z: number[]; depthAlpha: number; width: number; hue: number }>();

    if (this.display.showConnectors) for (const node of allFolders) {
      if (!node.path) continue; // root has no parent edge
      const parentPath = node.path.includes('/')
        ? node.path.substring(0, node.path.lastIndexOf('/'))
        : '';
      const parent = nodeByPath.get(parentPath);
      if (!parent) continue;

      const rawW       = node.connectionWidth;
      const scaledW    = this.display.connectorWidth * (W_OUT_MIN + (W_OUT_MAX - W_OUT_MIN) * (rawW - W_IN_MIN) / (W_IN_MAX - W_IN_MIN));
      const depthBucket = Math.min(Math.floor((node.z - zMin) / zRange * DEPTH_BUCKETS), DEPTH_BUCKETS - 1);
      const depthAlpha  = 0.8 - 0.65 * (depthBucket / (DEPTH_BUCKETS - 1)); // 0.8 → 0.15
      const focused     = inFocus(node.path) && inFocus(parentPath);
      const hue         = folderHue(node.path);
      const hueBucket   = Math.floor(hue / (360 / HUE_BUCKETS));
      const hueCentre   = hueBucket * (360 / HUE_BUCKETS) + (360 / HUE_BUCKETS) / 2;
      const key         = `${Math.round(scaledW)}-${hueBucket}-${depthBucket}-${focused ? 1 : 0}`;

      if (!edgeGroups.has(key)) edgeGroups.set(key, { x: [], y: [], z: [], depthAlpha: focused ? depthAlpha : DIM, width: scaledW, hue: hueCentre });
      const g = edgeGroups.get(key)!;
      g.x.push(parent.x, node.x, NaN);
      g.y.push(parent.y, node.y, NaN);
      g.z.push(parent.z, node.z, NaN);
    }

    const traces: Plotly.Data[] = [];

    // Edge traces (one per width × hue × depth bucket)
    for (const [, g] of edgeGroups) {
      traces.push({
        type: 'scatter3d',
        mode: 'lines',
        x: g.x, y: g.y, z: g.z,
        opacity: this.display.connectorOpacity * g.depthAlpha,
        line: { color: `hsl(${g.hue},20%,60%)`, width: g.width },
        hoverinfo: 'skip',
        showlegend: false,
      } as Plotly.Data);
    }

    // Shared cbrt scale across files and folders so sizes are comparable
    // Plotly marker.size is diameter in pixels → volume ∝ d³ → d ∝ bytes^(1/3)
    const { dotMin, dotMax } = this.display;
    const allCbrt = [
      ...folders.map(n => Math.cbrt(subtreeSize.get(n.path) ?? 1)),
      ...files.map(n => Math.cbrt(n.fileSize ?? 0)),
    ];
    const cbrtMin   = Math.min(...allCbrt);
    const cbrtMax   = Math.max(...allCbrt);
    const cbrtRange = cbrtMax - cbrtMin || 1;
    const toSize = (bytes: number) =>
      dotMin + (dotMax - dotMin) * (Math.cbrt(bytes) - cbrtMin) / cbrtRange;

    // Helper to push a marker trace for a subset of nodes
    const pushMarkers = (subset: TreeNode[], opacity: number, name: string, color: (n: TreeNode) => string, sizeOf: (n: TreeNode) => number, textOf: (n: TreeNode) => string) => {
      if (!subset.length) return;
      traces.push({
        type: 'scatter3d',
        mode: 'markers',
        x: subset.map(n => n.x),
        y: subset.map(n => n.y),
        z: subset.map(n => n.z),
        opacity,
        marker: {
          size: subset.map(sizeOf),
          color: subset.map(color),
          line: { width: 0 },
        },
        customdata: subset.map(n => n.path),
        text: subset.map(textOf),
        hovertemplate: '%{text}',
        name,
      } as Plotly.Data);
    };

    // Folder markers — split into focused/dimmed so trace-level opacity works
    if (folders.length) {
      const [fFoc, fDim] = focusSet
        ? [folders.filter(n => inFocus(n.path)), folders.filter(n => !inFocus(n.path))]
        : [folders, []];
      const fColor = (n: TreeNode) => folderColor(n.path);
      const fSize  = (n: TreeNode) => toSize(subtreeSize.get(n.path) ?? 1);
      const fText  = (n: TreeNode) => `<b>${n.path || '(root)'}</b><extra></extra>`;
      pushMarkers(fFoc, 1,   'folders',     fColor, fSize, fText);
      pushMarkers(fDim, DIM, 'folders-dim', fColor, fSize, fText);
    }

    // File markers — split into focused/dimmed
    if (files.length) {
      const [vFoc, vDim] = focusSet
        ? [files.filter(n => inFocus(n.path)), files.filter(n => !inFocus(n.path))]
        : [files, []];
      const vColor = (n: TreeNode) => extColor(n.path);
      const vSize  = (n: TreeNode) => toSize(n.fileSize ?? 0);
      const vText  = (n: TreeNode) => `<b>${n.path}</b><br>${(n.fileSize ?? 0).toLocaleString()} bytes<extra></extra>`;
      pushMarkers(vFoc, 1,   'files',     vColor, vSize, vText);
      pushMarkers(vDim, DIM, 'files-dim', vColor, vSize, vText);
    }

    return traces;
  }

  private buildLayout(title: string, preserveCamera = false): Partial<Plotly.Layout> {
    const allFolders = (this.result?.nodes ?? []).filter(n => !n.isFile);
    const coords     = allFolders.flatMap(n => [Math.abs(n.x), Math.abs(n.y)]);
    const xyMax      = Math.max(...coords, 1) * 1.1;
    const xyRange    = [-xyMax, xyMax];

    // Read current camera from the live Plotly figure when preserving
    const currentCamera = preserveCamera
      ? (this.el as any)?._fullLayout?.scene?.camera
      : null;
    const camera = currentCamera ?? { eye: { x: 0, y: 2.5, z: 0.5 }, up: { x: 0, y: 0, z: 1 } };

    return {
      title: { text: title, font: { color: '#e8eaef' } },
      paper_bgcolor: '#0c0e12',
      scene: {
        bgcolor: '#0c0e12',
        xaxis: {
          showbackground: false,
          showgrid: false,
          zeroline: false,
          showticklabels: false,
          showspikes: false,
          title: { text: '' },
          range: xyRange,
        },
        yaxis: {
          showbackground: false,
          showgrid: false,
          zeroline: false,
          showticklabels: false,
          showspikes: false,
          title: { text: '' },
          range: xyRange,
        },
        zaxis: {
          showbackground: false,
          showgrid: false,
          zeroline: false,
          showticklabels: false,
          showspikes: false,
          title: { text: '' },
        },
        aspectmode: 'auto',
        camera,
      },
      showlegend: false,
      margin: { l: 0, r: 0, t: 50, b: 0 },
      font: { color: '#c8d0e0' },
    };
  }
}
