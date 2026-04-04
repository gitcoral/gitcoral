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

    // Group folder edges by connectionWidth bucket for batched line rendering
    // Edges are built from allFolders so connectors are independent of folder visibility
    const edgeGroups = new Map<number, { x: number[]; y: number[]; z: number[] }>();

    if (this.display.showConnectors) for (const node of allFolders) {
      if (!node.path) continue; // root has no parent edge
      const parentPath = node.path.includes('/')
        ? node.path.substring(0, node.path.lastIndexOf('/'))
        : '';
      const parent = nodeByPath.get(parentPath);
      if (!parent) continue;

      const w = node.connectionWidth;
      if (!edgeGroups.has(w)) edgeGroups.set(w, { x: [], y: [], z: [] });
      const g = edgeGroups.get(w)!;
      g.x.push(parent.x, node.x, NaN);
      g.y.push(parent.y, node.y, NaN);
      g.z.push(parent.z, node.z, NaN);
    }

    const traces: Plotly.Data[] = [];

    // Edge traces (one per width bucket)
    for (const [width, g] of edgeGroups) {
      traces.push({
        type: 'scatter3d',
        mode: 'lines',
        x: g.x, y: g.y, z: g.z,
        opacity: this.display.connectorOpacity,
        line: { color: 'rgb(120,130,145)', width },
        hoverinfo: 'skip',
        showlegend: false,
      } as Plotly.Data);
    }

    // Folder markers
    if (folders.length) {
      const sqrtCounts = folders.map(n => Math.sqrt(n.subtreeFiles ?? 1));
      const sqrtCMin = Math.min(...sqrtCounts);
      const sqrtCMax = Math.max(...sqrtCounts);
      const sqrtCRange = sqrtCMax - sqrtCMin || 1;
      const { dotMin, dotMax } = this.display;
      traces.push({
        type: 'scatter3d',
        mode: 'markers',
        x: folders.map(n => n.x),
        y: folders.map(n => n.y),
        z: folders.map(n => n.z),
        marker: {
          size: folders.map(n =>
            dotMin + (dotMax - dotMin) * (Math.sqrt(n.subtreeFiles ?? 1) - sqrtCMin) / sqrtCRange
          ),
          color: 'rgba(100,150,220,0.35)',
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
          size: (() => {
            const sizes = files.map(n => n.fileSize ?? 0);
            const sqrtSizes = sizes.map(s => Math.sqrt(s));
            const sqrtMin = Math.min(...sqrtSizes);
            const sqrtMax = Math.max(...sqrtSizes);
            const sqrtRange = sqrtMax - sqrtMin || 1;
            const { dotMin, dotMax } = this.display;
            return files.map(n =>
              dotMin + (dotMax - dotMin) * (Math.sqrt(n.fileSize ?? 0) - sqrtMin) / sqrtRange
            );
          })(),
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
          gridcolor: 'rgba(80,90,110,0.25)',
          zerolinecolor: 'rgba(80,90,110,0.2)',
          color: '#8899aa',
          range: xyRange,
        },
        yaxis: {
          showbackground: false,
          gridcolor: 'rgba(80,90,110,0.25)',
          zerolinecolor: 'rgba(80,90,110,0.2)',
          color: '#8899aa',
          range: xyRange,
        },
        zaxis: {
          showbackground: false,
          gridcolor: 'rgba(80,90,110,0.25)',
          zerolinecolor: 'rgba(80,90,110,0.2)',
          color: '#8899aa',
          title: { text: 'depth' },
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
