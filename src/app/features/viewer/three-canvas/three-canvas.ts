import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { DEFAULT_DISPLAY_OPTIONS, DisplayOptions, LayoutResult, PositionedNode } from '../../../shared/models/tree-node.model';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  LessEqualDepth,
  MathUtils,
  Object3D,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIM               = 0.08;
const BG                = new Color(0x0c0e12);
const DEFAULT_COLOR     = new Color(0x8892a4);
const EDGE_WIDTH_IN_MIN = 2;
const EDGE_WIDTH_IN_MAX = 12;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashPath(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (Math.imul(31, h) + path.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.substring(0, i) : '';
}

function toHex(c: Color): string {
  return '#' + c.clone().convertLinearToSRGB().getHexString();
}

function makeCbrtNormalizer(values: number[], outMin: number, outMax: number): (v: number) => number {
  const cbrtValues = values.map(v => Math.cbrt(v));
  const min   = Math.min(...cbrtValues, 0);
  const max   = Math.max(...cbrtValues, 1);
  const range = max - min || 1;
  return (v: number) => outMin + (outMax - outMin) * (Math.cbrt(v) - min) / range;
}

export function buildExtColorMap(extCounts: Map<string, number>): Map<string, Color> {
  const GOLDEN = 0.61803398875;
  const sorted = [...extCounts.entries()].sort((a, b) => b[1] - a[1]);
  const map    = new Map<string, Color>();
  for (let i = 0; i < sorted.length; i++) {
    const hue       = Math.round((i * GOLDEN % 1) * 360);
    const lightness = i % 2 === 0 ? 65 : 75;
    map.set(sorted[i][0], new Color(`hsl(${hue},80%,${lightness}%)`));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Shaders for circular points with per-vertex size and colour
// ---------------------------------------------------------------------------

const VERT = /* glsl */`
  attribute float aSize;
  attribute vec3  aColor;
  attribute float aIsFolder;
  varying   vec3  vColor;
  varying   float vIsFolder;
  uniform   float uPixelRatio;

  void main() {
    vColor    = aColor;
    vIsFolder = aIsFolder;
    vec4 mv      = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
    gl_Position  = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  uniform float uOpacity;
  varying vec3  vColor;
  varying float vIsFolder;

  void main() {
    vec2  uv = gl_PointCoord - vec2(0.5);
    float r  = dot(uv, uv);
    if (r > 0.25) discard;
    // Folders: hollow ring (discard inner 55% of radius)
    if (vIsFolder > 0.5 && r < 0.075) discard;

    // Sphere impostor: reconstruct hemisphere normal from point coord
    float z      = sqrt(0.25 - r);
    vec3  normal = normalize(vec3(uv, z));

    vec3  light   = normalize(vec3(0.6, 0.8, 0.8));
    float diffuse = max(dot(normal, light), 0.0);
    float ambient = 0.25;

    vec3  halfVec = normalize(light + vec3(0.0, 0.0, 1.0));
    float spec    = pow(max(dot(normal, halfVec), 0.0), 32.0) * 0.4;

    vec3 lit = vColor * (ambient + diffuse) + vec3(spec);
    gl_FragColor = vec4(lit, uOpacity);
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@Component({
  selector: 'app-three-canvas',
  template: `<canvas #canvas style="display:block;width:100%;height:100%;"></canvas>`,
  styles: [`:host { display: block; width: 100%; height: 100%; background: #0c0e12; }`],
})
export class ThreeCanvas implements OnInit, OnChanges, OnDestroy {

  @Input() result: LayoutResult | null = null;
  @Input() resetCamera = false;
  @Input() display: DisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS };
  @Output() extColorsChange = new EventEmitter<{ ext: string; label: string; color: string; count: number }[]>();
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private renderer!: WebGLRenderer;
  private scene!: Scene;
  private camera!: PerspectiveCamera;
  private controls!: OrbitControls;
  private rafId = 0;
  private resizeObserver!: ResizeObserver;
  // Scene objects — replaced on each rebuildScene()
  private sceneObjects: Object3D[] = [];

  // Selection — drives both scene focus dimming and pinned tooltip
  private selectedNode: PositionedNode | null = null;

  // Tooltip
  private tipEl!: HTMLDivElement;
  private tipNodePos: Vector3 | null = null;
  private colorOf: ((n: PositionedNode) => Color) = () => DEFAULT_COLOR;

  // Track last result for which we emitted extColors
  private lastEmittedResult: LayoutResult | null = null;

  // Drag / orbit detection
  private mouseDownX = 0;
  private mouseDownY = 0;
  private isOrbiting = false;

  // Bound event handlers (needed for removeEventListener)
  private readonly onPointerMove  = this._onPointerMove.bind(this);
  private readonly onPointerLeave = this._onPointerLeave.bind(this);
  private readonly onMouseDown    = this._onMouseDown.bind(this);
  private readonly onClick        = this._onClick.bind(this);

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  ngOnInit(): void {
    this.initThree();
    this.startLoop();

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.canvasRef.nativeElement);

    this.tipEl = document.createElement('div');
    this.tipEl.className = 'orb-tip';
    this.tipEl.style.cssText = 'position:absolute;pointer-events:none;display:none;z-index:5;font-size:13px;-webkit-text-size-adjust:none;';
    this.canvasRef.nativeElement.parentElement!.appendChild(this.tipEl);

    const c = this.canvasRef.nativeElement;
    c.addEventListener('pointermove',  this.onPointerMove);
    c.addEventListener('pointerleave', this.onPointerLeave);
    c.addEventListener('mousedown',    this.onMouseDown);
    c.addEventListener('click',        this.onClick);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.renderer) return;
    if (changes['result']) {
      this.selectedNode = null;
      this.hideTooltip();
      this.rebuildScene();
      // Always fit on new result — resetCamera=false only suppresses it on param tweaks
      const isFirstLoad = !changes['result'].previousValue;
      if (this.resetCamera || isFirstLoad) requestAnimationFrame(() => this.fitCamera());
    } else if (changes['display']) {
      this.rebuildScene();
    }
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.tipEl.remove();
    this.controls.dispose();
    this.renderer.dispose();
    const c = this.canvasRef.nativeElement;
    c.removeEventListener('pointermove',  this.onPointerMove);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('mousedown',    this.onMouseDown);
    c.removeEventListener('click',        this.onClick);
  }

  // ---------------------------------------------------------------------------
  // Three.js setup
  // ---------------------------------------------------------------------------

  private initThree(): void {
    const canvas = this.canvasRef.nativeElement;
    const w = canvas.clientWidth  || 800;
    const h = canvas.clientHeight || 600;

    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setSize(w, h, false);

    this.scene = new Scene();
    this.scene.background = BG;

    this.camera = new PerspectiveCamera(60, w / h, 1, 2000);
    this.camera.position.set(0, 15, 5);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping  = true;
    this.controls.dampingFactor  = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('start', () => {
      this.isOrbiting = true;
      this.canvasRef.nativeElement.style.cursor = '';
      if (!this.selectedNode) this.hideTooltip();
    });
    this.controls.addEventListener('end', () => { this.isOrbiting = false; });
  }

  private startLoop(): void {
    const proj = new Vector3();
    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);

      if (this.tipNodePos && this.tipEl.style.display !== 'none') {
        const canvas = this.canvasRef.nativeElement;
        const rect = canvas.getBoundingClientRect();
        proj.copy(this.tipNodePos).project(this.camera);
        const sx = (proj.x + 1) / 2 * rect.width;
        const sy = (-proj.y + 1) / 2 * rect.height;
        this.tipEl.style.left = `${sx + 12}px`;
        this.tipEl.style.top  = `${sy + 12}px`;
      }
    };
    loop();
  }

  private onResize(): void {
    const c = this.canvasRef.nativeElement;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    for (const obj of this.sceneObjects) {
      if (obj instanceof Points) {
        const mat = obj.material as ShaderMaterial;
        if (mat.uniforms['uPixelRatio']) mat.uniforms['uPixelRatio'].value = devicePixelRatio;
      }
      if (obj instanceof LineSegments2) {
        (obj.material as LineMaterial).resolution.set(w, h);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Scene construction
  // ---------------------------------------------------------------------------

  private rebuildScene(): void {
    // Remove and dispose previous scene objects
    for (const obj of this.sceneObjects) {
      this.scene.remove(obj);
      if (obj instanceof Points || obj instanceof LineSegments2) {
        (obj as any).geometry.dispose();
        const mat = (obj as any).material;
        if (Array.isArray(mat)) mat.forEach((m: any) => m.dispose()); else mat.dispose();
      }
    }
    this.sceneObjects = [];

    if (!this.result) return;
    const nodes    = this.result.nodes;
    const focusSet = this.selectedNode ? this.buildFocusSet(nodes, this.selectedNode.path) : null;
    const inFocus  = (path: string) => !focusSet || focusSet.has(path);

    // Single pass: partition nodes into files and folders
    const allFiles: PositionedNode[]   = [];
    const folders: PositionedNode[] = [];
    for (const n of nodes) (n.isFile ? allFiles : folders).push(n);

    const fileExt = (path: string) => {
      const filename = path.slice(path.lastIndexOf('/') + 1);
      const dot = filename.lastIndexOf('.');
      return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : '';
    };

    // Colour map — extension → Color
    const extCounts = new Map<string, number>();
    let noExtCount = 0;
    for (const n of allFiles) {
      const ext = fileExt(n.path);
      if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
      else noExtCount++;
    }
    const colorMap = buildExtColorMap(extCounts);

    // Emit extension → CSS color list whenever the result (file set) changes
    if (this.result !== this.lastEmittedResult) {
      this.lastEmittedResult = this.result;
      const extColorsList = [...colorMap.entries()].map(([ext, color]) => ({
        ext,
        label: ext,
        color: toHex(color),
        count: extCounts.get(ext) ?? 0,
      }));
      if (noExtCount > 0) {
        const insertAt = extColorsList.findIndex(e => e.count <= noExtCount);
        const noneEntry = { ext: '', label: '(none)', color: toHex(DEFAULT_COLOR), count: noExtCount };
        if (insertAt === -1) extColorsList.push(noneEntry);
        else extColorsList.splice(insertAt, 0, noneEntry);
      }
      this.extColorsChange.emit(extColorsList);
    }

    const fileColor = (path: string): Color => {
      const ext = fileExt(path);
      return ext ? (colorMap.get(ext) ?? DEFAULT_COLOR) : DEFAULT_COLOR;
    };

    // Build parent → direct children map
    const childrenOf = new Map<string, PositionedNode[]>();
    for (const n of nodes) {
      const p = parentPath(n.path);
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p)!.push(n);
    }

    // Bottom-up: average children's colors into each folder (deepest folders first)
    const folderColorMap = new Map<string, Color>();
    const sortedFolders  = [...folders].sort((a, b) => b.path.split('/').length - a.path.split('/').length);

    for (const folder of sortedFolders) {
      const children = childrenOf.get(folder.path) ?? [];
      if (!children.length) { folderColorMap.set(folder.path, DEFAULT_COLOR); continue; }
      let r = 0, g = 0, b = 0;
      for (const child of children) {
        const c = child.isFile ? fileColor(child.path) : (folderColorMap.get(child.path) ?? DEFAULT_COLOR);
        r += c.r; g += c.g; b += c.b;
      }
      folderColorMap.set(folder.path, new Color(r / children.length, g / children.length, b / children.length));
    }

    this.colorOf = (n: PositionedNode): Color =>
      n.isFile ? fileColor(n.path) : (folderColorMap.get(n.path) ?? DEFAULT_COLOR);
    const colorOf = this.colorOf;

    // Visible files (filtered by size and hidden extensions)
    const { fileSizeMin, fileSizeMax, hiddenExtensions } = this.display;
    const hiddenExtSet = new Set(hiddenExtensions);
    const visibleFiles = this.display.showFiles
      ? allFiles.filter(n => {
          const size = n.fileSize ?? 0;
          return size >= fileSizeMin && size <= fileSizeMax && !hiddenExtSet.has(fileExt(n.path));
        })
      : [];

    // Mark folders that have at least one file passing size/extension filters.
    // Intentionally ignores showFiles so folders stay visible when files are toggled off,
    // but correctly hides empty folders when size/extension filters narrow the file set.
    const filteredForFolders = allFiles.filter(n => {
      const size = n.fileSize ?? 0;
      return size >= fileSizeMin && size <= fileSizeMax && !hiddenExtSet.has(fileExt(n.path));
    });
    const foldersWithContent = new Set<string>();
    for (const file of filteredForFolders) {
      let p = file.path;
      while (p.includes('/')) {
        p = parentPath(p);
        foldersWithContent.add(p);
      }
    }
    if (filteredForFolders.length) foldersWithContent.add(''); // root

    const visibleFolders = this.display.showFolders
      ? folders.filter(n => foldersWithContent.has(n.path))
      : [];

    const visible: PositionedNode[] = [...visibleFolders, ...visibleFiles];

    // Separate size scales for files and folders so each uses its own cbrt range.
    // Files are normalized against file sizes only — gives full fileDotMin–fileDotMax spread.
    // Folders are normalized against subtreeBytes with their own range.
    const { fileDotMin, fileDotMax, folderDotMin, folderDotMax } = this.display;
    const toFileSize   = makeCbrtNormalizer(allFiles.map(n => n.fileSize ?? 0), fileDotMin, fileDotMax);
    const toFolderSize = makeCbrtNormalizer(folders.map(n => n.subtreeBytes),   folderDotMin, folderDotMax);

    const toSize = (n: PositionedNode) =>
      n.isFile ? toFileSize(n.fileSize ?? 0) : toFolderSize(n.subtreeBytes);

    // Split focused / dimmed
    const focused = focusSet ? visible.filter(n =>  inFocus(n.path)) : visible;
    const dimmed  = focusSet ? visible.filter(n => !inFocus(n.path)) : [];

    if (focused.length) this.addPoints(focused, 1.0, colorOf, toSize);
    if (dimmed.length)  this.addPoints(dimmed,  DIM, colorOf, toSize);

    // Edges — use foldersWithContent so connectors stay visible when showFolders is off
    if (this.display.showConnectors) {
      const nodeByPath = new Map(nodes.map(n => [n.path, n]));
      const edgeFolders = folders.filter(n => foldersWithContent.has(n.path));
      this.addEdges(edgeFolders, nodeByPath, focusSet);
    }
  }

  private addPoints(
    subset: PositionedNode[],
    opacity: number,
    colorOf: (n: PositionedNode) => Color,
    toSize:  (n: PositionedNode) => number,
  ): void {
    const n   = subset.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const siz = new Float32Array(n);
    const fld = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const node = subset[i];
      pos[i * 3]     = -node.x; // negate X to preserve handedness after Y↔Z swap
      pos[i * 3 + 1] = node.z;  // layout Z is the elevation axis → Three.js Y (up)
      pos[i * 3 + 2] = node.y;
      const c = colorOf(node);
      col[i * 3]     = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      siz[i] = toSize(node);
      fld[i] = node.isFile ? 0 : 1;
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position',  new BufferAttribute(pos, 3));
    geo.setAttribute('aColor',    new BufferAttribute(col, 3));
    geo.setAttribute('aSize',     new BufferAttribute(siz, 1));
    geo.setAttribute('aIsFolder', new BufferAttribute(fld, 1));
    geo.userData['nodes'] = subset;

    const mat = new ShaderMaterial({
      vertexShader:   VERT,
      fragmentShader: FRAG,
      uniforms: {
        uOpacity:    { value: opacity },
        uPixelRatio: { value: devicePixelRatio },
      },
      transparent: true,
      depthWrite:  opacity >= 1,
      depthFunc:   LessEqualDepth,
    });

    const points = new Points(geo, mat);
    points.renderOrder = 0; // draw before connectors so dots write depth first
    this.scene.add(points);
    this.sceneObjects.push(points);
  }

  private addEdges(
    folders: PositionedNode[],
    nodeByPath: Map<string, PositionedNode>,
    focusSet: Set<string> | null,
  ): void {
    const inFocus = (path: string) => !focusSet || focusSet.has(path);
    const canvas  = this.canvasRef.nativeElement;

    const DEPTH_BUCKETS = 8;
    const zValues = folders.map(n => n.z);
    const zMin    = Math.min(...zValues, 0);
    const zRange  = Math.max(...zValues, 1) - zMin || 1;

    // Group segments by (focused, depthBucket, widthBucket) — each batch = one material
    type Batch = { pos: number[]; col: number[]; depthAlpha: number; width: number };
    const batches = new Map<string, Batch>();

    for (const node of folders) {
      if (!node.path) continue;
      const pp     = parentPath(node.path);
      const parent = nodeByPath.get(pp);
      if (!parent) continue;

      const hue        = hashPath(node.path) % 360;
      const c          = new Color(`hsl(${hue},20%,60%)`);
      const focused    = inFocus(node.path) && inFocus(pp);
      const depthBucket = Math.min(
        Math.floor((node.z - zMin) / zRange * DEPTH_BUCKETS), DEPTH_BUCKETS - 1);
      const { connectorOpacityMin, connectorOpacityMax } = this.display;
      const depthAlpha  = focused
        ? connectorOpacityMax - (connectorOpacityMax - connectorOpacityMin) * (depthBucket / (DEPTH_BUCKETS - 1))
        : DIM;
      const t = Math.max(0, Math.min(1, (node.connectionWidth - EDGE_WIDTH_IN_MIN) / (EDGE_WIDTH_IN_MAX - EDGE_WIDTH_IN_MIN)));
      const scaledW = this.display.connectorWidthMin + (this.display.connectorWidthMax - this.display.connectorWidthMin) * t;
      const wBucket = Math.round(scaledW * 2) / 2;
      const key     = `${focused ? 1 : 0}-${depthBucket}-${wBucket}`;

      if (!batches.has(key)) batches.set(key, { pos: [], col: [], depthAlpha, width: scaledW });
      const b = batches.get(key)!;
      // Swap Y↔Z: layout Z is elevation → Three.js Y
      b.pos.push(-parent.x, parent.z, parent.y, -node.x, node.z, node.y);
      b.col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }

    for (const [, { pos, col, width, depthAlpha }] of batches) {
      const geo      = new LineSegmentsGeometry();
      geo.setPositions(pos);
      geo.setColors(col);
      const mat = new LineMaterial({
        vertexColors:        true,
        transparent:         true,
        opacity:             depthAlpha,
        linewidth:           width,
        depthWrite:          false,
        resolution:          new Vector2(canvas.clientWidth, canvas.clientHeight),
        worldUnits:          false,
        polygonOffset:       true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits:  1,
      });
      const segs = new LineSegments2(geo, mat);
      segs.renderOrder = 1; // draw after dots; depthWrite:false lets dots show through
      this.scene.add(segs);
      this.sceneObjects.push(segs);
    }
  }

  // ---------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------

  private fitCamera(): void {
    const nodes = this.result?.nodes;
    if (!nodes?.length) return;

    // Refresh aspect ratio from actual canvas size
    const canvas = this.canvasRef.nativeElement;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w && h) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    // Bounding box directly from node positions in Three.js space (-n.x, n.z, n.y)
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const n of nodes) {
      const x = -n.x, y = n.z, z = n.y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;

    const vFov  = MathUtils.degToRad(this.camera.fov);
    const hFov  = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const tanH  = Math.tan(hFov / 2);
    const tanV  = Math.tan(vFov / 2);

    // Camera axes for fixed elevation angle (looking from +Z side, slightly above)
    const elev = 0.2; // ~11°
    // forward d = (0, -sin, -cos), right r = (1, 0, 0), up u = (0, cos, -sin)
    const sd = Math.sin(elev), cd = Math.cos(elev);

    // Exact minimum dist: for each node, dist >= |dx|/tanH - dz  AND  |dy|/tanV - dz
    // where dx/dy/dz are projections of (node - center) onto camera right/up/forward axes.
    let minDist = 0;
    for (const n of nodes) {
      const vx = -n.x - cx;   // Three.js coords relative to scene center
      const vy =  n.z - cy;
      const vz =  n.y - cz;

      const dx =  vx;                   // dot(v, right=(1,0,0))
      const dy =  vy * cd - vz * sd;    // dot(v, up=(0,cos,-sin))
      const dz = -vy * sd - vz * cd;    // dot(v, forward=(0,-sin,-cos))

      minDist = Math.max(minDist, Math.abs(dx) / tanH - dz);
      minDist = Math.max(minDist, Math.abs(dy) / tanV - dz);
    }
    const dist = minDist * 1.02; // 2% breathing room

    this.controls.target.set(cx, cy, cz);
    this.camera.position.set(cx, cy + dist * sd, cz + dist * cd);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  // ---------------------------------------------------------------------------
  // Focus system
  // ---------------------------------------------------------------------------

  private buildFocusSet(nodes: PositionedNode[], focusPath: string): Set<string> {
    const set = new Set<string>();
    set.add(focusPath);
    const parts = focusPath.split('/');
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    set.add('');
    const prefix = focusPath ? focusPath + '/' : '';
    for (const n of nodes) {
      if (prefix === '' || n.path.startsWith(prefix)) set.add(n.path);
    }
    return set;
  }

  // ---------------------------------------------------------------------------
  // Raycasting (hover + click)
  // ---------------------------------------------------------------------------

  private raycast(event: MouseEvent): { node: PositionedNode; worldPos: Vector3 } | null {
    const canvas = this.canvasRef.nativeElement;
    const rect   = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const W = rect.width;
    const H = rect.height;

    // Screen-space hit test: project each point to CSS pixels and check radius.
    // This is correct for billboard points whose visual size is fixed in pixels
    // regardless of camera distance, unlike a world-space raycaster threshold.
    let closest: { depth: number; node: PositionedNode; worldPos: Vector3 } | null = null;
    const proj = new Vector3();

    for (const obj of this.sceneObjects) {
      if (!(obj instanceof Points)) continue;
      const nodes   = obj.geometry.userData['nodes'] as PositionedNode[];
      const posAttr = obj.geometry.getAttribute('position') as BufferAttribute;
      const sizAttr = obj.geometry.getAttribute('aSize')    as BufferAttribute;

      for (let i = 0; i < nodes.length; i++) {
        proj.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        const worldPos = proj.clone();
        proj.project(this.camera); // → NDC

        if (proj.z > 1) continue; // behind near/far clip

        // NDC → CSS pixels
        const sx = (proj.x + 1) / 2 * W;
        const sy = (-proj.y + 1) / 2 * H;

        const dx = mouseX - sx;
        const dy = mouseY - sy;

        // aSize is the point diameter in CSS pixels (gl_PointSize = aSize * devicePixelRatio)
        const radius = sizAttr.getX(i) / 2;
        if (dx * dx + dy * dy > radius * radius) continue;

        // Among overlapping points pick the one closest to camera (smallest NDC z)
        if (!closest || proj.z < closest.depth) {
          closest = { depth: proj.z, node: nodes[i], worldPos };
        }
      }
    }

    return closest ? { node: closest.node, worldPos: closest.worldPos } : null;
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private _onMouseDown(e: MouseEvent): void {
    this.mouseDownX = e.clientX;
    this.mouseDownY = e.clientY;
  }

  private showTooltip(node: PositionedNode, worldPos: Vector3): void {
    const hex = toHex(this.colorOf(node));
    this.tipEl.innerHTML = node.isFile
      ? `<div>${node.path}</div><div>${(node.fileSize ?? 0).toLocaleString()} bytes</div>`
      : `<div>${node.path || '(root)'}</div>`;
    this.tipEl.style.background = hex;
    this.tipEl.style.display = '';
    this.tipNodePos = worldPos;
  }

  private hideTooltip(): void {
    this.tipEl.style.display = 'none';
    this.tipNodePos = null;
  }

  private _onPointerMove(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    if (this.isOrbiting) return;

    if (this.selectedNode) {
      const hit = this.raycast(e);
      this.canvasRef.nativeElement.style.cursor = hit ? 'pointer' : '';
      return;
    }

    const hit = this.raycast(e);
    if (hit) {
      this.showTooltip(hit.node, hit.worldPos);
      this.canvasRef.nativeElement.style.cursor = 'pointer';
    } else {
      this.hideTooltip();
      this.canvasRef.nativeElement.style.cursor = '';
    }
  }

  private _onPointerLeave(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    if (this.selectedNode) return; // keep pinned tooltip visible
    this.hideTooltip();
    this.canvasRef.nativeElement.style.cursor = '';
  }

  private _onClick(e: MouseEvent): void {
    const dx = e.clientX - this.mouseDownX;
    const dy = e.clientY - this.mouseDownY;
    if (dx * dx + dy * dy > 16) return; // drag, not click

    const hit = this.raycast(e);
    if (hit) {
      const isToggle = this.selectedNode?.path === hit.node.path;
      this.selectedNode = isToggle ? null : hit.node;
      if (isToggle) {
        this.hideTooltip();
      } else {
        this.showTooltip(hit.node, hit.worldPos);
      }
    } else {
      if (!this.selectedNode) return;
      this.selectedNode = null;
      this.hideTooltip();
    }
    if (this.result) this.rebuildScene();
  }
}
