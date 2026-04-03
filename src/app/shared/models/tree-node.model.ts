export interface TreeNode {
  path: string;
  isFile: boolean;
  x: number;
  y: number;
  z: number;
  connectionWidth: number;
  nodeSize: number;
  fileSize?: number;      // bytes, files only
  subtreeFiles?: number;  // folders only, used during layout
  children?: TreeNode[];  // used during layout, not in final output
}

export interface LayoutParams {
  layerHeight: number;
  zScale: number;
  buoyancy: number;
  repulsion: number;
  decay: number;
  dotD: number;
}

export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
  layerHeight: 2.0,
  zScale: 0.5,
  buoyancy: 2.0,
  repulsion: 1.5,
  decay: 0.82,
  dotD: 0.02,
};

export type LoadingState = 'idle' | 'fetching' | 'computing';

export interface DisplayOptions {
  showFolders: boolean;
  showFiles: boolean;
  showConnectors: boolean;
  connectorOpacity: number;
  dotMin: number;
  dotMax: number;
}

export const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = {
  showFolders: false,
  showFiles: true,
  showConnectors: true,
  connectorOpacity: 0.4,
  dotMin: 4.0,
  dotMax: 20.0,
};

export interface LayoutResult {
  nodes: TreeNode[];
  repoName: string;
}

export interface WorkerRequest {
  root: TreeNode;
  params: LayoutParams;
  repoName: string;
}

export interface WorkerResponse {
  result: LayoutResult;
  error?: string;
}
