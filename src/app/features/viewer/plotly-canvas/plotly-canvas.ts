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
  if (dot < 0 || dot === path.length - 1) return 'hsl(220,15%,55%)'; // no extension
  const ext = path.slice(dot + 1).toLowerCase();
  let h = 0;
  for (let i = 0; i < ext.length; i++) h = (Math.imul(31, h) + ext.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue},65%,62%)`;
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

  ngOnInit(): void {
    this.initEmpty();
    this.resizeObserver = new ResizeObserver(() => {
      Plotly.Plots.resize(this.el);
    });
    this.resizeObserver.observe(this.el);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['result'] || changes['display']) && this.result) {
      const onlyDisplayChanged = !changes['result'] && !!changes['display'];
      const preserveCamera = onlyDisplayChanged || (!!changes['result']?.previousValue && !this.resetCamera);
      this.render(this.result, preserveCamera);
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver.disconnect();
    Plotly.purge(this.el);
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
      const hue         = folderHue(node.path);
      const hueBucket   = Math.floor(hue / (360 / HUE_BUCKETS));
      const hueCentre   = hueBucket * (360 / HUE_BUCKETS) + (360 / HUE_BUCKETS) / 2;
      const key         = `${Math.round(scaledW)}-${hueBucket}-${depthBucket}`;

      if (!edgeGroups.has(key)) edgeGroups.set(key, { x: [], y: [], z: [], depthAlpha, width: scaledW, hue: hueCentre });
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

    // Folder markers
    if (folders.length) {
      traces.push({
        type: 'scatter3d',
        mode: 'markers',
        x: folders.map(n => n.x),
        y: folders.map(n => n.y),
        z: folders.map(n => n.z),
        marker: {
          size: folders.map(n => toSize(subtreeSize.get(n.path) ?? 1)),
          color: folders.map(n => {
            let h = 0;
            for (let i = 0; i < n.path.length; i++) h = (Math.imul(31, h) + n.path.charCodeAt(i)) | 0;
            return `hsla(${Math.abs(h) % 360},35%,42%,0.5)`;
          }),
          line: { width: 0 },
        },
        text: folders.map(n => `<b>${n.path || '(root)'}</b><extra></extra>`),
        hovertemplate: '%{text}',
        name: 'folders',
      } as Plotly.Data);
    }

    // File markers
    if (files.length) {
      traces.push({
        type: 'scatter3d',
        mode: 'markers',
        x: files.map(n => n.x),
        y: files.map(n => n.y),
        z: files.map(n => n.z),
        marker: {
          size: files.map(n => toSize(n.fileSize ?? 0)),
          color: files.map(n => extColor(n.path)),
          line: { width: 0 },
        },
        text: files.map(n =>
          `<b>${n.path}</b><br>${(n.fileSize ?? 0).toLocaleString()} bytes<extra></extra>`
        ),
        hovertemplate: '%{text}',
        name: 'files',
      } as Plotly.Data);
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
