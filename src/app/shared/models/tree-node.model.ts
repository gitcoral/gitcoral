// ---------------------------------------------------------------------------
// Phase 1 — GitHub fetch output / worker input
// Children are present; layout fields (x/y/z etc.) are not yet assigned.
// ---------------------------------------------------------------------------
export interface TreeStructure {
  path: string;
  isFile: boolean;
  fileSize?: number;       // bytes, files only
  subtreeBytes: number;    // total bytes under this node (folders) or file size (files)
  children: TreeStructure[];
}

// ---------------------------------------------------------------------------
// Phase 2 — Worker output / renderer input
// Flat array (children stripped); all spatial fields are populated.
// ---------------------------------------------------------------------------
export interface PositionedNode {
  path: string;
  isFile: boolean;
  fileSize?: number;
  subtreeBytes: number;    // total bytes under this node — pre-computed for renderer
  x: number;
  y: number;
  z: number;
  connectionWidth: number; // 0 for files
}

// ---------------------------------------------------------------------------
// Shared parameter / option types
// ---------------------------------------------------------------------------

export interface LayoutParams {
  layerHeight: number;
  zScale: number;
  buoyancy: number;
  repulsion: number;
  decay: number;
  sphereD: number;
}

export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
  layerHeight: 2.0,
  zScale: 0.5,
  buoyancy: 2.0,
  repulsion: 1.5,
  decay: 0.82,
  sphereD: 0.02,
};

export type LoadingState = 'idle' | 'fetching' | 'computing';

export interface DisplayOptions {
  showFolders: boolean;
  showFiles: boolean;
  showConnectors: boolean;
  connectorOpacityMin: number;
  connectorOpacityMax: number;
  connectorWidthMin: number;
  connectorWidthMax: number;
  fileDotMin: number;
  fileDotMax: number;
  folderDotMin: number;
  folderDotMax: number;
  fileSizeMin: number;
  fileSizeMax: number;
  hiddenExtensions: string[];
}

export const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = {
  showFolders: true,
  showFiles: true,
  showConnectors: true,
  connectorOpacityMin: 0.1,
  connectorOpacityMax: 0.8,
  connectorWidthMin: 1,
  connectorWidthMax: 10,
  fileDotMin: 4.0,
  fileDotMax: 20.0,
  folderDotMin: 2.0,
  folderDotMax: 10.0,
  fileSizeMin: 0,
  fileSizeMax: Number.MAX_SAFE_INTEGER,
  hiddenExtensions: [],
};

export interface LayoutResult {
  nodes: PositionedNode[];
  repoName: string;
}

export interface WorkerRequest {
  root: TreeStructure;
  params: LayoutParams;
  repoName: string;
}

export interface WorkerResponse {
  result: LayoutResult;
  error?: string;
}
