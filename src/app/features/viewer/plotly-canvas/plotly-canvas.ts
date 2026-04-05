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
import { DEFAULT_DISPLAY_OPTIONS, DisplayOptions, LayoutResult, PositionedNode } from '../../../shared/models/tree-node.model';

// Plotly is loaded as a side-effect import; types come from @types/plotly.js-dist-min
import * as Plotly from 'plotly.js-dist-min';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIM           = 0.08; // opacity for out-of-focus nodes
const DEPTH_BUCKETS = 5;
const HUE_BUCKETS   = 8;
// Connector width: map layout's 2–12px range down to 1–5px for Plotly
const W_IN_MIN = 2, W_IN_MAX = 12, W_OUT_MIN = 1, W_OUT_MAX = 5;

// ---------------------------------------------------------------------------
// Colour helpers — share the same polynomial hash
// ---------------------------------------------------------------------------

function hashPath(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (Math.imul(31, h) + path.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function extColor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) return 'hsl(220,15%,55%)';
  const hue = hashPath(path.slice(dot + 1).toLowerCase()) % 360;
  return `hsl(${hue},65%,62%)`;
}

function folderColor(path: string): string {
  return `hsl(${hashPath(path) % 360},35%,42%)`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  private buildFocusSet(nodes: PositionedNode[], focusPath: string): Set<string> {
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
  // Rendering pipeline
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

  /** One line-trace per (width × hue × depth × focus) bucket — batches edges for Plotly. */
  private buildEdgeTraces(
    allFolders: PositionedNode[],
    nodeByPath: Map<string, PositionedNode>,
    focusSet: Set<string> | null,
  ): Plotly.Data[] {
    const inFocus = (path: string) => !focusSet || focusSet.has(path);

    const zValues = allFolders.map(n => n.z);
    const zMin    = Math.min(...zValues, 0);
    const zMax    = Math.max(...zValues, 1);
    const zRange  = zMax - zMin || 1;

    type EdgeGroup = { x: number[]; y: number[]; z: number[]; depthAlpha: number; width: number; hue: number };
    const groups = new Map<string, EdgeGroup>();

    for (const node of allFolders) {
      if (!node.path) continue; // root has no parent edge
      const parentPath = node.path.includes('/')
        ? node.path.substring(0, node.path.lastIndexOf('/'))
        : '';
      const parent = nodeByPath.get(parentPath);
      if (!parent) continue;

      const scaledW     = this.display.connectorWidth *
        (W_OUT_MIN + (W_OUT_MAX - W_OUT_MIN) * (node.connectionWidth - W_IN_MIN) / (W_IN_MAX - W_IN_MIN));
      const depthBucket = Math.min(Math.floor((node.z - zMin) / zRange * DEPTH_BUCKETS), DEPTH_BUCKETS - 1);
      const depthAlpha  = 0.8 - 0.65 * (depthBucket / (DEPTH_BUCKETS - 1)); // 0.8 → 0.15
      const focused     = inFocus(node.path) && inFocus(parentPath);
      const hue         = hashPath(node.path) % 360;
      const hueBucket   = Math.floor(hue / (360 / HUE_BUCKETS));
      const hueCentre   = hueBucket * (360 / HUE_BUCKETS) + (360 / HUE_BUCKETS) / 2;
      const key         = `${Math.round(scaledW)}-${hueBucket}-${depthBucket}-${focused ? 1 : 0}`;

      if (!groups.has(key)) {
        groups.set(key, { x: [], y: [], z: [], depthAlpha: focused ? depthAlpha : DIM, width: scaledW, hue: hueCentre });
      }
      const g = groups.get(key)!;
      g.x.push(parent.x, node.x, NaN);
      g.y.push(parent.y, node.y, NaN);
      g.z.push(parent.z, node.z, NaN);
    }

    return [...groups.values()].map(g => ({
      type: 'scatter3d',
      mode: 'lines',
      x: g.x, y: g.y, z: g.z,
      opacity: this.display.connectorOpacity * g.depthAlpha,
      line: { color: `hsl(${g.hue},20%,60%)`, width: g.width },
      hoverinfo: 'skip',
      showlegend: false,
    } as Plotly.Data));
  }

  /** Scatter3d marker traces for folders and files, split into focused/dimmed pairs. */
  private buildMarkerTraces(
    folders: PositionedNode[],
    files: PositionedNode[],
    focusSet: Set<string> | null,
  ): Plotly.Data[] {
    const inFocus = (path: string) => !focusSet || focusSet.has(path);

    // Shared cbrt scale across files and folders so sizes are visually comparable.
    // Plotly marker.size is diameter in pixels → volume ∝ d³ → d ∝ bytes^(1/3)
    const { dotMin, dotMax } = this.display;
    const allCbrt   = [
      ...folders.map(n => Math.cbrt(n.subtreeBytes)),
      ...files.map(n => Math.cbrt(n.fileSize ?? 0)),
    ];
    const cbrtMin   = Math.min(...allCbrt);
    const cbrtMax   = Math.max(...allCbrt);
    const cbrtRange = cbrtMax - cbrtMin || 1;
    const toSize    = (bytes: number) =>
      dotMin + (dotMax - dotMin) * (Math.cbrt(bytes) - cbrtMin) / cbrtRange;

    const split = (nodes: PositionedNode[]) => focusSet
      ? [nodes.filter(n =>  inFocus(n.path)), nodes.filter(n => !inFocus(n.path))] as const
      : [nodes, [] as PositionedNode[]] as const;

    const makeTrace = (
      subset: PositionedNode[],
      opacity: number,
      name: string,
      color: (n: PositionedNode) => string,
      sizeOf: (n: PositionedNode) => number,
      textOf: (n: PositionedNode) => string,
    ): Plotly.Data => ({
      type: 'scatter3d',
      mode: 'markers',
      x: subset.map(n => n.x),
      y: subset.map(n => n.y),
      z: subset.map(n => n.z),
      opacity,
      marker: { size: subset.map(sizeOf), color: subset.map(color), line: { width: 0 } },
      customdata: subset.map(n => n.path),
      text: subset.map(textOf),
      hovertemplate: '%{text}',
      name,
    } as Plotly.Data);

    const traces: Plotly.Data[] = [];

    if (folders.length) {
      const [fFoc, fDim] = split(folders);
      const fColor = (n: PositionedNode) => folderColor(n.path);
      const fSize  = (n: PositionedNode) => toSize(n.subtreeBytes);
      const fText  = (n: PositionedNode) => `<b>${n.path || '(root)'}</b><extra></extra>`;
      if (fFoc.length) traces.push(makeTrace(fFoc, 1,   'folders',     fColor, fSize, fText));
      if (fDim.length) traces.push(makeTrace(fDim, DIM, 'folders-dim', fColor, fSize, fText));
    }

    if (files.length) {
      const [vFoc, vDim] = split(files);
      const vColor = (n: PositionedNode) => extColor(n.path);
      const vSize  = (n: PositionedNode) => toSize(n.fileSize ?? 0);
      const vText  = (n: PositionedNode) => `<b>${n.path}</b><br>${(n.fileSize ?? 0).toLocaleString()} bytes<extra></extra>`;
      if (vFoc.length) traces.push(makeTrace(vFoc, 1,   'files',     vColor, vSize, vText));
      if (vDim.length) traces.push(makeTrace(vDim, DIM, 'files-dim', vColor, vSize, vText));
    }

    return traces;
  }

  /** Orchestrates the three trace-building steps. */
  private buildTraces(nodes: PositionedNode[]): Plotly.Data[] {
    const allFolders = nodes.filter(n => !n.isFile);
    const folders    = this.display.showFolders ? allFolders : [];
    const files      = this.display.showFiles   ? nodes.filter(n => n.isFile) : [];
    const focusSet   = this.focusPath ? this.buildFocusSet(nodes, this.focusPath) : null;
    const nodeByPath = new Map<string, PositionedNode>(nodes.map(n => [n.path, n]));

    return [
      ...(this.display.showConnectors ? this.buildEdgeTraces(allFolders, nodeByPath, focusSet) : []),
      ...this.buildMarkerTraces(folders, files, focusSet),
    ];
  }

  private buildLayout(title: string, preserveCamera = false): Partial<Plotly.Layout> {
    const allNodes   = this.result?.nodes ?? [];
    const allFolders = allNodes.filter(n => !n.isFile);
    const coords     = allFolders.flatMap(n => [Math.abs(n.x), Math.abs(n.y)]);
    const xyMax      = Math.max(...coords, 1) * 1.1;
    const xyRange    = [-xyMax, xyMax];

    // Read current camera from the live Plotly figure when preserving
    const currentCamera = preserveCamera
      ? (this.el as any)?._fullLayout?.scene?.camera
      : null;

    // Compute initial camera distance from tree bounding box so the full tree
    // is visible on first load without needing to zoom in.
    // Plotly eye coords are in normalised scene units where 1 = half the axis range.
    // We place the eye along +Y at a distance proportional to the largest dimension.
    let camera = currentCamera;
    if (!camera) {
      const xs = allNodes.map(n => n.x);
      const ys = allNodes.map(n => n.y);
      const zs = allNodes.map(n => n.z);
      const spanX = Math.max(...xs) - Math.min(...xs) || 1;
      const spanY = Math.max(...ys) - Math.min(...ys) || 1;
      const spanZ = Math.max(...zs) - Math.min(...zs) || 1;
      const maxSpan = Math.max(spanX, spanY, spanZ);
      // Normalise against the xy axis range (2*xyMax = full axis width in data units).
      // eye distance of 1 shows roughly one axis-width; scale so maxSpan fits.
      const dist = Math.max(1.2, (maxSpan / (2 * xyMax)) * 1.5);
      camera = { eye: { x: 0, y: dist, z: dist * 0.25 }, up: { x: 0, y: 0, z: 1 } };
    }

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
