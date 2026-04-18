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

const DIM = 0.08;
const BG  = new Color(0x0c0e12);

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function hashPath(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (Math.imul(31, h) + path.charCodeAt(i)) | 0;
  return Math.abs(h);
}


export function buildExtColorMap(extCounts: Map<string, number>): Map<string, Color> {
  const GOLDEN = 0.61803398875;
  const sorted = [...extCounts.entries()].sort((a, b) => b[1] - a[1]);
  const map    = new Map<string, Color>();
  sorted.forEach(([ext], i) => {
    const hue       = Math.round((i * GOLDEN % 1) * 360);
    const lightness = i % 2 === 0 ? 65 : 75;
    map.set(ext, new Color(`hsl(${hue},80%,${lightness}%)`));
  });
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
    gl_FragColor = vec4(vColor, uOpacity);
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
  private colorOf: ((n: PositionedNode) => Color) = () => new Color('#8892a4');

  // Track last result for which we emitted extColors
  private lastEmittedResult: LayoutResult | null = null;

  // Drag / orbit detection
  private mouseDownX = 0;
  private mouseDownY = 0;
  private isOrbiting = false;

  // Bound event handlers (needed for removeEventListener)
  private readonly onMouseMove  = this._onMouseMove.bind(this);
  private readonly onMouseLeave = this._onMouseLeave.bind(this);
  private readonly onMouseDown  = this._onMouseDown.bind(this);
  private readonly onClick      = this._onClick.bind(this);

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
    this.tipEl.style.cssText = 'position:fixed;pointer-events:none;display:none;z-index:5;';
    document.body.appendChild(this.tipEl);

    const c = this.canvasRef.nativeElement;
    c.addEventListener('mousemove',  this.onMouseMove);
    c.addEventListener('mouseleave', this.onMouseLeave);
    c.addEventListener('mousedown',  this.onMouseDown);
    c.addEventListener('click',      this.onClick);
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
    c.removeEventListener('mousemove',  this.onMouseMove);
    c.removeEventListener('mouseleave', this.onMouseLeave);
    c.removeEventListener('mousedown',  this.onMouseDown);
    c.removeEventListener('click',      this.onClick);
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

    this.camera = new PerspectiveCamera(60, w / h, 0.01, 2000);
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
        const sx = (proj.x + 1) / 2 * rect.width  + rect.left;
        const sy = (-proj.y + 1) / 2 * rect.height + rect.top;
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

    // Colour map — extension → Color
    const extCounts = new Map<string, number>();
    let noExtCount = 0;
    for (const n of allFiles) {
      const filename = n.path.slice(n.path.lastIndexOf('/') + 1);
      const dot = filename.lastIndexOf('.');
      if (dot < 0 || dot >= filename.length - 1) { noExtCount++; continue; }
      const ext = filename.slice(dot + 1).toLowerCase();
      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }
    const colorMap = buildExtColorMap(extCounts);

    // Emit extension → CSS color list whenever the result (file set) changes
    if (this.result !== this.lastEmittedResult) {
      this.lastEmittedResult = this.result;
      const extColorsList = [...colorMap.entries()].map(([ext, color]) => ({
        ext,
        label: ext,
        color: '#' + color.clone().convertLinearToSRGB().getHexString(),
        count: extCounts.get(ext) ?? 0,
      }));
      if (noExtCount > 0) {
        const insertAt = extColorsList.findIndex(e => e.count <= noExtCount);
        const noneEntry = { ext: '', label: '(none)', color: '#8892a4', count: noExtCount };
        if (insertAt === -1) extColorsList.push(noneEntry);
        else extColorsList.splice(insertAt, 0, noneEntry);
      }
      this.extColorsChange.emit(extColorsList);
    }

    const fileExt = (path: string) => {
      const filename = path.slice(path.lastIndexOf('/') + 1);
      const dot = filename.lastIndexOf('.');
      return dot >= 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : '';
    };

    const fileColor = (path: string): Color => {
      const ext = fileExt(path);
      return ext ? (colorMap.get(ext) ?? new Color('#8892a4')) : new Color('#8892a4');
    };

    // Build parent → direct children map
    const childrenOf = new Map<string, PositionedNode[]>();
    for (const n of nodes) {
      const parentPath = n.path.includes('/') ? n.path.substring(0, n.path.lastIndexOf('/')) : '';
      if (!childrenOf.has(parentPath)) childrenOf.set(parentPath, []);
      childrenOf.get(parentPath)!.push(n);
    }

    // Bottom-up: average children's colors into each folder (deepest folders first)
    const folderColorMap = new Map<string, Color>();
    const sortedFolders  = [...folders].sort((a, b) => b.path.split('/').length - a.path.split('/').length);

    for (const folder of sortedFolders) {
      const children = childrenOf.get(folder.path) ?? [];
      if (!children.length) { folderColorMap.set(folder.path, new Color('#8892a4')); continue; }
      let r = 0, g = 0, b = 0;
      for (const child of children) {
        const c = child.isFile ? fileColor(child.path) : (folderColorMap.get(child.path) ?? new Color('#8892a4'));
        r += c.r; g += c.g; b += c.b;
      }
      folderColorMap.set(folder.path, new Color(r / children.length, g / children.length, b / children.length));
    }

    this.colorOf = (n: PositionedNode): Color =>
      n.isFile ? fileColor(n.path) : (folderColorMap.get(n.path) ?? new Color('#8892a4'));
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

    // Mark folders that have at least one visible file anywhere in their subtree
    const foldersWithContent = new Set<string>();
    for (const file of visibleFiles) {
      let p = file.path;
      while (p.includes('/')) {
        p = p.substring(0, p.lastIndexOf('/'));
        foldersWithContent.add(p);
      }
    }
    if (visibleFiles.length) foldersWithContent.add(''); // root

    const visibleFolders = this.display.showFolders
      ? folders.filter(n => foldersWithContent.has(n.path))
      : [];

    const visible: PositionedNode[] = [...visibleFolders, ...visibleFiles];

    // Separate size scales for files and folders so each uses its own cbrt range.
    // Files are normalized against file sizes only — gives full fileDotMin–fileDotMax spread.
    // Folders are normalized against subtreeBytes with their own range.
    const { fileDotMin, fileDotMax } = this.display;
    const fileCbrt      = allFiles.map(n => Math.cbrt(n.fileSize ?? 0));
    const fileCbrtMin   = Math.min(...fileCbrt, 0);
    const fileCbrtMax   = Math.max(...fileCbrt, 1);
    const fileCbrtRange = fileCbrtMax - fileCbrtMin || 1;
    const toFileSize    = (bytes: number) =>
      fileDotMin + (fileDotMax - fileDotMin) * (Math.cbrt(bytes) - fileCbrtMin) / fileCbrtRange;

    const { folderDotMin, folderDotMax } = this.display;
    const folderCbrt      = folders.map(n => Math.cbrt(n.subtreeBytes));
    const folderCbrtMin   = Math.min(...folderCbrt, 0);
    const folderCbrtMax   = Math.max(...folderCbrt, 1);
    const folderCbrtRange = folderCbrtMax - folderCbrtMin || 1;
    const toFolderSize    = (bytes: number) =>
      folderDotMin + (folderDotMax - folderDotMin) * (Math.cbrt(bytes) - folderCbrtMin) / folderCbrtRange;

    const toSize = (n: PositionedNode) =>
      n.isFile ? toFileSize(n.fileSize ?? 0) : toFolderSize(n.subtreeBytes);

    // Split focused / dimmed
    const focused = focusSet ? visible.filter(n =>  inFocus(n.path)) : visible;
    const dimmed  = focusSet ? visible.filter(n => !inFocus(n.path)) : [];

    if (focused.length) this.addPoints(focused, 1.0, colorOf, toSize);
    if (dimmed.length)  this.addPoints(dimmed,  DIM, colorOf, toSize);

    // Edges
    if (this.display.showConnectors) {
      const nodeByPath = new Map(nodes.map(n => [n.path, n]));
      this.addEdges(visibleFolders, nodeByPath, focusSet);
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
      const parentPath = node.path.includes('/')
        ? node.path.substring(0, node.path.lastIndexOf('/'))
        : '';
      const parent = nodeByPath.get(parentPath);
      if (!parent) continue;

      const hue        = hashPath(node.path) % 360;
      const c          = new Color(`hsl(${hue},20%,60%)`);
      const focused    = inFocus(node.path) && inFocus(parentPath);
      const depthBucket = Math.min(
        Math.floor((node.z - zMin) / zRange * DEPTH_BUCKETS), DEPTH_BUCKETS - 1);
      const { connectorOpacityMin, connectorOpacityMax } = this.display;
      const depthAlpha  = focused
        ? connectorOpacityMax - (connectorOpacityMax - connectorOpacityMin) * (depthBucket / (DEPTH_BUCKETS - 1))
        : DIM;
      const W_IN_MIN = 2, W_IN_MAX = 12;
      const t = Math.max(0, Math.min(1, (node.connectionWidth - W_IN_MIN) / (W_IN_MAX - W_IN_MIN)));
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
    const hex = '#' + this.colorOf(node).clone().convertLinearToSRGB().getHexString();
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

  private _onMouseMove(e: MouseEvent): void {
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

  private _onMouseLeave(): void {
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
