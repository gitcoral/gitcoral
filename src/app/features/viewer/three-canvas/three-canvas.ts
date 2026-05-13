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
import {
  DEFAULT_DISPLAY_OPTIONS,
  DisplayOptions,
  LayoutResult,
  PositionedNode,
} from '../../../shared/models/tree-node.model';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  LessEqualDepth,
  MathUtils,
  Mesh,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VERT, FRAG } from './node-shaders';
import { EDGE_VERT, EDGE_FRAG } from './edge-shaders';
import {
  DEFAULT_COLOR,
  buildExtColorMap,
  buildExtColorFn,
  buildDepthColorFn,
  buildDiffColorFn,
  buildFileSizeColorFn,
  toHex,
} from './color-palette';
import { buildFocusSet, fileExt, hashPath, makeCbrtNormalizer, parentPath } from './scene-utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIM = 0.08;
const PATH_DIM = 0.08;
const DIFF_DIM = 0.12;
const BG = new Color(0x0c0e12);
const EDGE_WIDTH_IN_MIN = 2;
const EDGE_WIDTH_IN_MAX = 12;
// Converts CSS-pixel-valued display settings to world units so nodes/connectors
// scale naturally with camera distance. Value chosen so the default view looks
// the same as the previous fixed-pixel rendering.
const WORLD_SCALE = 100;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@Component({
  selector: 'app-three-canvas',
  template: `<canvas #canvas style="display:block;width:100%;height:100%;"></canvas>`,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        background: #0c0e12;
      }
    `,
  ],
})
export class ThreeCanvas implements OnInit, OnChanges, OnDestroy {
  @Input() result: LayoutResult | null = null;
  @Input() resetCamera = false;
  @Input() display: DisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS };
  @Input() cameraParam: string | null = null;
  @Input() autoOrbit = false;
  @Output() extColorsChange = new EventEmitter<
    { ext: string; label: string; color: string; count: number }[]
  >();
  @Output() cameraChange = new EventEmitter<string>();
  @Output() autoOrbitChange = new EventEmitter<boolean>();
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private renderer!: WebGLRenderer;
  private scene!: Scene;
  private camera!: PerspectiveCamera;
  private controls!: OrbitControls;
  private rafId = 0;
  private resizeObserver!: ResizeObserver;

  // Selection — drives both scene focus dimming and pinned tooltip
  private selectedNode: PositionedNode | null = null;

  // Tooltip
  private tipEl!: HTMLDivElement;
  private tipNodePos: Vector3 | null = null;
  private colorOf: (n: PositionedNode) => Color = () => DEFAULT_COLOR;
  private dimmedPaths: Set<string> = new Set();

  // Track last result for which we emitted extColors
  private lastEmittedResult: LayoutResult | null = null;

  // Geometry — rebuilt only when result changes
  private cachedFiles: PositionedNode[] = [];
  private cachedFolders: PositionedNode[] = [];
  private nodesMesh: Points | null = null;
  private alphaAttr: BufferAttribute | null = null;
  private colorAttr: BufferAttribute | null = null;
  private sizeAttr: BufferAttribute | null = null;
  private edgeMesh: Mesh | null = null;

  // Drag / orbit detection
  private mouseDownX = 0;
  private mouseDownY = 0;
  private isOrbiting = false;
  private didOrbit = false;

  // Bound event handlers (needed for removeEventListener)
  private readonly onPointerMove = this._onPointerMove.bind(this);
  private readonly onPointerLeave = this._onPointerLeave.bind(this);
  private readonly onMouseDown = this._onMouseDown.bind(this);
  private readonly onClick = this._onClick.bind(this);

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
    this.tipEl.style.cssText =
      'position:absolute;pointer-events:none;display:none;z-index:5;font-size:13px;-webkit-text-size-adjust:none;';
    this.canvasRef.nativeElement.parentElement!.appendChild(this.tipEl);

    const c = this.canvasRef.nativeElement;
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerleave', this.onPointerLeave);
    c.addEventListener('mousedown', this.onMouseDown);
    c.addEventListener('click', this.onClick);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.renderer) return;
    if (changes['autoOrbit']) {
      this.controls.autoRotate = this.autoOrbit;
    }
    if (changes['result']) {
      this.selectedNode = null;
      this.hideTooltip();
      this.buildGeometry();
      const isFirstLoad = !changes['result'].previousValue;
      if (isFirstLoad && this.cameraParam) {
        requestAnimationFrame(() => this.restoreCamera(this.cameraParam!));
      } else if (this.resetCamera || isFirstLoad) {
        requestAnimationFrame(() => this.fitCamera());
      }
    } else if (changes['display']) {
      this.updateScene();
    }
  }

  takeSnapshot(filename = 'gitcoral-snapshot.png'): void {
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.tipEl.remove();
    this.controls.dispose();
    this.renderer.dispose();
    const c = this.canvasRef.nativeElement;
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('mousedown', this.onMouseDown);
    c.removeEventListener('click', this.onClick);
  }

  // ---------------------------------------------------------------------------
  // Three.js setup
  // ---------------------------------------------------------------------------

  private initThree(): void {
    const canvas = this.canvasRef.nativeElement;
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 600;

    this.renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setSize(w, h, false);

    this.scene = new Scene();
    this.scene.background = BG;

    this.camera = new PerspectiveCamera(60, w / h, 1, 2000);
    this.camera.position.set(0, 15, 5);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.autoRotateSpeed = 0.8;
    this.controls.addEventListener('start', () => {
      this.isOrbiting = true;
      this.canvasRef.nativeElement.style.cursor = '';
      if (!this.selectedNode) this.hideTooltip();
      if (this.autoOrbit) this.autoOrbitChange.emit(false);
    });
    this.controls.addEventListener('change', () => {
      if (this.isOrbiting) this.didOrbit = true;
    });
    this.controls.addEventListener('end', () => {
      this.isOrbiting = false;
      const p = this.camera.position;
      const t = this.controls.target;
      const r = (v: number) => Math.round(v * 100) / 100;
      this.cameraChange.emit(`${r(p.x)},${r(p.y)},${r(p.z)},${r(t.x)},${r(t.y)},${r(t.z)}`);
    });
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
        const sx = ((proj.x + 1) / 2) * rect.width;
        const sy = ((-proj.y + 1) / 2) * rect.height;
        this.tipEl.style.left = `${sx + 12}px`;
        this.tipEl.style.top = `${sy + 12}px`;
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
    if (this.nodesMesh) {
      const mat = this.nodesMesh.material as ShaderMaterial;
      if (mat.uniforms['uPixelRatio']) mat.uniforms['uPixelRatio'].value = devicePixelRatio;
      if (mat.uniforms['uViewportH']) mat.uniforms['uViewportH'].value = h;
    }
    if (this.edgeMesh) {
      (this.edgeMesh.material as ShaderMaterial).uniforms['uResolution'].value.set(w, h);
    }
  }

  // ---------------------------------------------------------------------------
  // Scene construction
  // ---------------------------------------------------------------------------

  // Full rebuild — called only when result changes.
  private buildGeometry(): void {
    this.disposeAll();
    if (!this.result) return;

    const nodes = this.result.nodes;
    this.cachedFiles = [];
    this.cachedFolders = [];
    for (const n of nodes) (n.isFile ? this.cachedFiles : this.cachedFolders).push(n);

    const n = nodes.length;
    const pos = new Float32Array(n * 3);
    const fld = new Float32Array(n);
    const col = new Float32Array(n * 3);
    const siz = new Float32Array(n);
    const alp = new Float32Array(n);

    // Folders first, then files — matches the order expected by updateScene and raycast.
    const allNodes: PositionedNode[] = new Array(n);
    let i = 0;
    for (const node of this.cachedFolders) {
      pos[i * 3] = -node.x;
      pos[i * 3 + 1] = node.z;
      pos[i * 3 + 2] = node.y;
      fld[i] = 1;
      allNodes[i] = node;
      i++;
    }
    for (const node of this.cachedFiles) {
      pos[i * 3] = -node.x;
      pos[i * 3 + 1] = node.z;
      pos[i * 3 + 2] = node.y;
      // fld[i] stays 0 (Float32Array default)
      allNodes[i] = node;
      i++;
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('aIsFolder', new BufferAttribute(fld, 1));
    this.colorAttr = new BufferAttribute(col, 3);
    geo.setAttribute('aColor', this.colorAttr);
    this.sizeAttr = new BufferAttribute(siz, 1);
    geo.setAttribute('aSize', this.sizeAttr);
    this.alphaAttr = new BufferAttribute(alp, 1);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.userData['nodes'] = allNodes;

    const canvas = this.canvasRef.nativeElement;
    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uPixelRatio: { value: devicePixelRatio },
        uViewportH: { value: canvas.clientHeight || 600 },
      },
      transparent: true,
      depthWrite: true,
      depthFunc: LessEqualDepth,
    });

    this.nodesMesh = new Points(geo, mat);
    this.nodesMesh.renderOrder = 0;
    this.scene.add(this.nodesMesh);

    this.updateScene();
  }

  // Attribute update — called on display/selection changes. No geometry allocation.
  private updateScene(): void {
    if (!this.result || !this.nodesMesh) return;

    const nodes = this.result.nodes;
    const colorOf = this.buildColorFn(this.cachedFiles, this.cachedFolders, nodes);
    const { fileDotMin, fileDotMax, folderDotMin, folderDotMax } = this.display;
    const toFileSize = makeCbrtNormalizer(
      this.cachedFiles.map((n) => n.fileSize ?? 0),
      fileDotMin,
      fileDotMax,
    );
    const toFolderSize = makeCbrtNormalizer(
      this.cachedFolders.map((n) => n.subtreeBytes),
      folderDotMin,
      folderDotMax,
    );
    const toSize = (n: PositionedNode) =>
      n.isFile ? toFileSize(n.fileSize ?? 0) : toFolderSize(n.subtreeBytes);

    const focusSet = this.selectedNode ? buildFocusSet(nodes, this.selectedNode.path) : null;
    const {
      visibleFiles,
      visibleFolders,
      pathDimmedFiles,
      pathDimmedFolders,
      foldersWithContent,
      inDepthRange,
    } = this.computeVisibility(this.cachedFiles, this.cachedFolders);

    const pathDimmedSet = new Set([...pathDimmedFolders, ...pathDimmedFiles].map((n) => n.path));
    const visibleSet = new Set([...visibleFolders, ...visibleFiles].map((n) => n.path));
    const diffDimmedSet = this.result?.isDiff
      ? new Set(nodes.filter((n) => n.diffStatus === 'unchanged').map((n) => n.path))
      : new Set<string>();
    const focusDimmedSet = focusSet
      ? new Set(nodes.filter((n) => !focusSet.has(n.path)).map((n) => n.path))
      : new Set<string>();
    this.dimmedPaths = new Set([...pathDimmedSet, ...diffDimmedSet, ...focusDimmedSet]);
    const inFocus = (path: string) => !focusSet || focusSet.has(path);

    const meshNodes = this.nodesMesh.geometry.userData['nodes'] as PositionedNode[];
    const col = this.colorAttr!;
    const siz = this.sizeAttr!;
    const alp = this.alphaAttr!;

    for (let i = 0; i < meshNodes.length; i++) {
      const node = meshNodes[i];
      const c = colorOf(node);
      col.setXYZ(i, c.r, c.g, c.b);
      siz.setX(i, toSize(node) / WORLD_SCALE);
      const active = visibleSet.has(node.path) || pathDimmedSet.has(node.path);
      const diffUnchanged = !!this.result?.isDiff && node.diffStatus === 'unchanged';
      alp.setX(
        i,
        !active
          ? 0
          : focusSet
            ? inFocus(node.path)
              ? diffUnchanged
                ? DIFF_DIM
                : 1.0
              : DIM
            : pathDimmedSet.has(node.path)
              ? PATH_DIM
              : diffUnchanged
                ? DIFF_DIM
                : 1.0,
      );
    }

    col.needsUpdate = true;
    siz.needsUpdate = true;
    alp.needsUpdate = true;

    this.disposeEdges();
    if (this.display.showConnectors) {
      const nodeByPath = new Map(nodes.map((n) => [n.path, n]));
      const edgeFolders = this.cachedFolders.filter(
        (n) => foldersWithContent.has(n.path) && inDepthRange(n.path),
      );
      const pathDimmedFolderPaths = new Set(pathDimmedFolders.map((n) => n.path));
      this.addEdges(edgeFolders, nodeByPath, focusSet, pathDimmedFolderPaths);
    }
  }

  private disposeAll(): void {
    this.disposeEdges();
    if (this.nodesMesh) {
      this.scene.remove(this.nodesMesh);
      this.nodesMesh.geometry.dispose();
      (this.nodesMesh.material as ShaderMaterial).dispose();
      this.nodesMesh = null;
    }
    this.alphaAttr = null;
    this.colorAttr = null;
    this.sizeAttr = null;
  }

  private disposeEdges(): void {
    if (this.edgeMesh) {
      this.scene.remove(this.edgeMesh);
      this.edgeMesh.geometry.dispose();
      (this.edgeMesh.material as ShaderMaterial).dispose();
      this.edgeMesh = null;
    }
  }

  // Emits extColorsChange when the result changes (always extension-based, independent of
  // colorMode), then builds and returns a colorOf function for the active color mode.
  private buildColorFn(
    allFiles: PositionedNode[],
    folders: PositionedNode[],
    nodes: PositionedNode[],
  ): (n: PositionedNode) => Color {
    // Always compute extension data — needed for the chip filter regardless of color mode.
    if (this.result !== this.lastEmittedResult) {
      this.lastEmittedResult = this.result;
      const extCounts = new Map<string, number>();
      let noExtCount = 0;
      for (const n of allFiles) {
        const ext = fileExt(n.path);
        if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
        else noExtCount++;
      }
      const extColorMap = buildExtColorMap(extCounts);
      const list = [...extColorMap.entries()].map(([ext, color]) => ({
        ext,
        label: ext,
        color: toHex(color),
        count: extCounts.get(ext) ?? 0,
      }));
      if (noExtCount > 0) {
        const noneEntry = {
          ext: '',
          label: '(none)',
          color: toHex(DEFAULT_COLOR),
          count: noExtCount,
        };
        const insertAt = list.findIndex((e) => e.count <= noExtCount);
        if (insertAt === -1) list.push(noneEntry);
        else list.splice(insertAt, 0, noneEntry);
      }
      this.extColorsChange.emit(list);
    }

    switch (this.display.colorMode) {
      case 'depth':
        this.colorOf = buildDepthColorFn(nodes);
        break;
      case 'size':
        this.colorOf = buildFileSizeColorFn(nodes);
        break;
      case 'diff':
        this.colorOf = buildDiffColorFn(nodes);
        break;
      default:
        this.colorOf = buildExtColorFn(allFiles, folders, nodes);
        break;
    }
    return this.colorOf;
  }

  // Filters files and folders by the current display options. foldersWithContent drives
  // both folder visibility and connector rendering (independent of showFiles).
  private computeVisibility(
    allFiles: PositionedNode[],
    folders: PositionedNode[],
  ): {
    visibleFiles: PositionedNode[];
    visibleFolders: PositionedNode[];
    pathDimmedFiles: PositionedNode[];
    pathDimmedFolders: PositionedNode[];
    foldersWithContent: Set<string>;
    inDepthRange: (path: string) => boolean;
  } {
    const {
      fileSizeMin,
      fileSizeMax,
      hiddenExtensions,
      showFiles,
      showFolders,
      depthMin,
      depthMax,
      pathQuery,
    } = this.display;
    const hiddenExtSet = new Set(hiddenExtensions);
    const passesFilter = (n: PositionedNode) => {
      const size = n.fileSize ?? 0;
      return size >= fileSizeMin && size <= fileSizeMax && !hiddenExtSet.has(fileExt(n.path));
    };

    // Walk ancestors of every filter-passing file to mark which folders have content.
    // Intentionally ignores showFiles so folders stay visible when files are toggled off.
    const foldersWithContent = new Set<string>();
    const filtered = allFiles.filter(passesFilter);
    for (const file of filtered) {
      let p = file.path;
      while (p.includes('/')) {
        p = parentPath(p);
        foldersWithContent.add(p);
      }
    }
    if (filtered.length) foldersWithContent.add(''); // root

    const nodeDepth = (path: string) => (path === '' ? 0 : path.split('/').length);
    const inDepthRange = (path: string) => {
      const d = nodeDepth(path);
      return d >= depthMin && d <= depthMax;
    };

    // Folders that have content AND are within the depth range (independent of showFolders,
    // so files can be culled by their parent's depth visibility even when showFolders is off).
    const depthVisibleFolderPaths = new Set(
      folders
        .filter((n) => foldersWithContent.has(n.path) && inDepthRange(n.path))
        .map((n) => n.path),
    );

    // Path query: walk ancestors of matching files to compute which folders contain a match.
    const q = pathQuery.trim().toLowerCase();
    const foldersMatchingQuery = new Set<string>();
    if (q) {
      for (const file of filtered.filter(
        (n) => depthVisibleFolderPaths.has(parentPath(n.path)) && n.path.toLowerCase().includes(q),
      )) {
        foldersMatchingQuery.add(file.path);
        let p = file.path;
        while (p.includes('/')) {
          p = parentPath(p);
          foldersMatchingQuery.add(p);
        }
      }
      if (foldersMatchingQuery.size) foldersMatchingQuery.add('');
    }

    const matchesQuery = (n: PositionedNode) => !q || n.path.toLowerCase().includes(q);
    const folderInQuery = (n: PositionedNode) => !q || foldersMatchingQuery.has(n.path);

    const visibleFolders = showFolders
      ? folders.filter((n) => depthVisibleFolderPaths.has(n.path) && folderInQuery(n))
      : [];
    const pathDimmedFolders =
      showFolders && q
        ? folders.filter((n) => depthVisibleFolderPaths.has(n.path) && !folderInQuery(n))
        : [];
    const visibleFiles = showFiles
      ? allFiles.filter(
          (n) =>
            passesFilter(n) && depthVisibleFolderPaths.has(parentPath(n.path)) && matchesQuery(n),
        )
      : [];
    const pathDimmedFiles =
      showFiles && q
        ? allFiles.filter(
            (n) =>
              passesFilter(n) &&
              depthVisibleFolderPaths.has(parentPath(n.path)) &&
              !matchesQuery(n),
          )
        : [];

    return {
      visibleFiles,
      visibleFolders,
      pathDimmedFiles,
      pathDimmedFolders,
      foldersWithContent,
      inDepthRange,
    };
  }

  private addEdges(
    folders: PositionedNode[],
    nodeByPath: Map<string, PositionedNode>,
    focusSet: Set<string> | null,
    pathDimmedPaths?: Set<string>,
  ): void {
    const inFocus = (path: string) => !focusSet || focusSet.has(path);
    const isPathDim = (path: string) => !focusSet && !!pathDimmedPaths?.has(path);

    const zValues = folders.map((n) => n.z);
    const zMin = Math.min(...zValues, 0);
    const zRange = Math.max(...zValues, 1) - zMin || 1;

    type Seg = {
      sx: number;
      sy: number;
      sz: number;
      ex: number;
      ey: number;
      ez: number;
      r: number;
      g: number;
      b: number;
      alpha: number;
      width: number;
    };
    const segs: Seg[] = [];

    for (const node of folders) {
      if (!node.path) continue;
      const pp = parentPath(node.path);
      const parent = nodeByPath.get(pp);
      if (!parent) continue;

      const hue = hashPath(node.path) % 360;
      const c = new Color(`hsl(${hue},20%,60%)`);
      const focused = inFocus(node.path) && inFocus(pp);
      const pathDimmed = isPathDim(node.path) || isPathDim(pp);
      const diffUnchanged = !!this.result?.isDiff && node.diffStatus === 'unchanged';
      const depthT = Math.min((node.z - zMin) / zRange, 1.0);
      const { connectorOpacityMin, connectorOpacityMax } = this.display;
      const alpha = focused
        ? pathDimmed
          ? PATH_DIM
          : diffUnchanged
            ? DIFF_DIM
            : connectorOpacityMax - (connectorOpacityMax - connectorOpacityMin) * depthT
        : DIM;
      const t = Math.max(
        0,
        Math.min(
          1,
          (node.connectionWidth - EDGE_WIDTH_IN_MIN) / (EDGE_WIDTH_IN_MAX - EDGE_WIDTH_IN_MIN),
        ),
      );
      const width =
        (this.display.connectorWidthMin +
          (this.display.connectorWidthMax - this.display.connectorWidthMin) * t) /
        WORLD_SCALE;

      // Swap Y↔Z: layout Z is elevation → Three.js Y
      segs.push({
        sx: -parent.x,
        sy: parent.z,
        sz: parent.y,
        ex: -node.x,
        ey: node.z,
        ez: node.y,
        r: c.r,
        g: c.g,
        b: c.b,
        alpha,
        width,
      });
    }

    if (!segs.length) return;

    const N = segs.length;
    const V = N * 4; // 4 vertices per segment

    const posArr = new Float32Array(V * 3); // dummy positions (computed in vertex shader)
    const startArr = new Float32Array(V * 3);
    const endArr = new Float32Array(V * 3);
    const colorArr = new Float32Array(V * 3);
    const alphaArr = new Float32Array(V);
    const widthArr = new Float32Array(V);
    const isEndArr = new Float32Array(V);
    const sideArr = new Float32Array(V);
    const idxArr = new Uint32Array(N * 6);

    // Corner pattern: [start-left, start-right, end-right, end-left]
    const IS_END: [number, number, number, number] = [0, 0, 1, 1];
    const SIDE: [number, number, number, number] = [-1, 1, 1, -1];

    for (let i = 0; i < N; i++) {
      const s = segs[i];
      const base = i * 4;
      for (let j = 0; j < 4; j++) {
        const v = base + j;
        startArr[v * 3] = s.sx;
        startArr[v * 3 + 1] = s.sy;
        startArr[v * 3 + 2] = s.sz;
        endArr[v * 3] = s.ex;
        endArr[v * 3 + 1] = s.ey;
        endArr[v * 3 + 2] = s.ez;
        colorArr[v * 3] = s.r;
        colorArr[v * 3 + 1] = s.g;
        colorArr[v * 3 + 2] = s.b;
        alphaArr[v] = s.alpha;
        widthArr[v] = s.width;
        isEndArr[v] = IS_END[j];
        sideArr[v] = SIDE[j];
      }
      const ii = i * 6;
      idxArr[ii] = base;
      idxArr[ii + 1] = base + 2;
      idxArr[ii + 2] = base + 1;
      idxArr[ii + 3] = base;
      idxArr[ii + 4] = base + 3;
      idxArr[ii + 5] = base + 2;
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(posArr, 3));
    geo.setAttribute('aStart', new BufferAttribute(startArr, 3));
    geo.setAttribute('aEnd', new BufferAttribute(endArr, 3));
    geo.setAttribute('aColor', new BufferAttribute(colorArr, 3));
    geo.setAttribute('aAlpha', new BufferAttribute(alphaArr, 1));
    geo.setAttribute('aWidth', new BufferAttribute(widthArr, 1));
    geo.setAttribute('aIsEnd', new BufferAttribute(isEndArr, 1));
    geo.setAttribute('aSide', new BufferAttribute(sideArr, 1));
    geo.setIndex(new BufferAttribute(idxArr, 1));

    const canvas = this.canvasRef.nativeElement;
    const mat = new ShaderMaterial({
      vertexShader: EDGE_VERT,
      fragmentShader: EDGE_FRAG,
      uniforms: {
        uResolution: { value: new Vector2(canvas.clientWidth, canvas.clientHeight) },
      },
      transparent: true,
      depthWrite: false,
    });

    this.edgeMesh = new Mesh(geo, mat);
    this.edgeMesh.frustumCulled = false;
    this.edgeMesh.renderOrder = 1; // draw after dots; depthWrite:false lets dots show through
    this.scene.add(this.edgeMesh);
  }

  // ---------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------

  private restoreCamera(param: string): void {
    const parts = param.split(',').map(Number);
    if (parts.length !== 6 || parts.some(isNaN)) {
      this.fitCamera();
      return;
    }
    const [px, py, pz, tx, ty, tz] = parts;
    this.controls.target.set(tx, ty, tz);
    this.camera.position.set(px, py, pz);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  resetToDefaultCamera(): void {
    this.fitCamera();
    const r = (v: number) => Math.round(v * 100) / 100;
    const p = this.camera.position,
      t = this.controls.target;
    this.cameraChange.emit(`${r(p.x)},${r(p.y)},${r(p.z)},${r(t.x)},${r(t.y)},${r(t.z)}`);
  }

  private fitCamera(): void {
    const nodes = this.result?.nodes;
    if (!nodes?.length) return;

    // Refresh aspect ratio from actual canvas size
    const canvas = this.canvasRef.nativeElement;
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (w && h) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    // Bounding box directly from node positions in Three.js space (-n.x, n.z, n.y)
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;
    let minZ = Infinity,
      maxZ = -Infinity;
    for (const n of nodes) {
      const x = -n.x,
        y = n.z,
        z = n.y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;

    const vFov = MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const tanH = Math.tan(hFov / 2);
    const tanV = Math.tan(vFov / 2);

    // Camera axes for fixed elevation angle (looking from +Z side, slightly above)
    const elev = 0.2; // ~11°
    // forward d = (0, -sin, -cos), right r = (1, 0, 0), up u = (0, cos, -sin)
    const sd = Math.sin(elev),
      cd = Math.cos(elev);

    // Exact minimum dist: for each node, dist >= |dx|/tanH - dz  AND  |dy|/tanV - dz
    // where dx/dy/dz are projections of (node - center) onto camera right/up/forward axes.
    let minDist = 0;
    for (const n of nodes) {
      const vx = -n.x - cx; // Three.js coords relative to scene center
      const vy = n.z - cy;
      const vz = n.y - cz;

      const dx = vx; // dot(v, right=(1,0,0))
      const dy = vy * cd - vz * sd; // dot(v, up=(0,cos,-sin))
      const dz = -vy * sd - vz * cd; // dot(v, forward=(0,-sin,-cos))

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
  // Raycasting (hover + click)
  // ---------------------------------------------------------------------------

  private raycast(
    event: MouseEvent,
    exclude?: Set<string>,
  ): { node: PositionedNode; worldPos: Vector3 } | null {
    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const W = rect.width;
    const H = rect.height;

    // Screen-space hit test: project each point to CSS pixels and check radius.
    let closest: { depth: number; node: PositionedNode; worldPos: Vector3 } | null = null;
    const proj = new Vector3();
    // projectionMatrix[1][1] = cot(fov/2); used to convert world size → screen pixels
    const focalLen = this.camera.projectionMatrix.elements[5];

    if (!this.nodesMesh) return null;
    {
      const obj = this.nodesMesh;
      const nodes = obj.geometry.userData['nodes'] as PositionedNode[];
      const posAttr = obj.geometry.getAttribute('position') as BufferAttribute;
      const sizAttr = obj.geometry.getAttribute('aSize') as BufferAttribute;
      const alpAttr = obj.geometry.getAttribute('aAlpha') as BufferAttribute;

      for (let i = 0; i < nodes.length; i++) {
        if (alpAttr.getX(i) <= 0) continue;
        if (exclude?.has(nodes[i].path)) continue;

        proj.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        const worldPos = proj.clone();
        // Eye-space depth before projecting to NDC
        const eyeZ = proj.applyMatrix4(this.camera.matrixWorldInverse).z;
        proj.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        proj.project(this.camera); // → NDC

        if (proj.z > 1) continue; // behind near/far clip

        // NDC → CSS pixels
        const sx = ((proj.x + 1) / 2) * W;
        const sy = ((-proj.y + 1) / 2) * H;

        const dx = mouseX - sx;
        const dy = mouseY - sy;

        // aSize is in world units; convert to screen-space pixel radius for hit testing
        const screenRadius = ((sizAttr.getX(i) / 2) * focalLen * (H / 2)) / -eyeZ;
        const radius = Math.max(screenRadius, 6);
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

  private showTooltip(node: PositionedNode, worldPos: Vector3, isSelected = false): void {
    const hex = toHex(this.colorOf(node));
    let line1: HTMLElement;
    if (isSelected && this.result) {
      const link = document.createElement('a');
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = node.path || '(root)';
      link.style.cssText = 'color:#1a56db;pointer-events:auto;text-decoration:underline;';

      if (this.result.prNumber && node.path) {
        const prFilesUrl = `https://github.com/${this.result.repoName}/pull/${this.result.prNumber}/files`;
        link.href = prFilesUrl;
        if (node.isFile) {
          const bytes = new TextEncoder().encode(node.path);
          crypto.subtle.digest('SHA-256', bytes).then((buf) => {
            const hex = Array.from(new Uint8Array(buf))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('');
            link.href = `${prFilesUrl}#diff-${hex}`;
          });
        }
      } else {
        const type = node.isFile ? 'blob' : 'tree';
        const isDeleted = node.diffStatus === 'deleted';
        const linkRepo = isDeleted
          ? this.result.repoName
          : this.result.headRepoName || this.result.repoName;
        const linkRef = isDeleted
          ? this.result.vsRef || this.result.ref || 'HEAD'
          : this.result.ref || 'HEAD';
        link.href = `https://github.com/${linkRepo}/${type}/${linkRef}/${node.path}`;
      }

      line1 = link;
    } else {
      line1 = document.createElement('div');
      line1.textContent = node.path || '(root)';
    }
    this.tipEl.replaceChildren(line1);
    if (node.isFile) {
      const line2 = document.createElement('div');
      line2.textContent = `${(node.fileSize ?? 0).toLocaleString()} bytes`;
      this.tipEl.appendChild(line2);
    }
    if (node.diffStatus) {
      const diffLine = document.createElement('div');
      diffLine.textContent = node.diffStatus;
      this.tipEl.appendChild(diffLine);
    }
    this.tipEl.style.background = hex;
    this.tipEl.style.pointerEvents = 'auto';
    this.tipEl.style.display = '';
    this.tipNodePos = worldPos;
  }

  private hideTooltip(): void {
    this.tipEl.style.display = 'none';
    this.tipEl.style.pointerEvents = 'none';
    this.tipNodePos = null;
  }

  private _onPointerMove(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    if (this.isOrbiting) return;

    if (this.selectedNode) {
      const hit = this.raycast(e, this.dimmedPaths);
      this.canvasRef.nativeElement.style.cursor = hit ? 'pointer' : '';
      return;
    }

    const hit = this.raycast(e, this.dimmedPaths);
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
    if (this.didOrbit) {
      this.didOrbit = false;
      return;
    }
    const dx = e.clientX - this.mouseDownX;
    const dy = e.clientY - this.mouseDownY;
    if (dx * dx + dy * dy > 16) return; // drag, not click

    const hit = this.raycast(e, this.dimmedPaths);
    if (hit) {
      const isToggle = this.selectedNode?.path === hit.node.path;
      this.selectedNode = isToggle ? null : hit.node;
      if (isToggle) {
        this.hideTooltip();
      } else {
        this.showTooltip(hit.node, hit.worldPos, true);
      }
    } else {
      if (!this.selectedNode) return;
      this.selectedNode = null;
      this.hideTooltip();
    }
    if (this.result) this.updateScene();
  }
}
