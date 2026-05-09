/// <reference lib="webworker" />

import { WorkerRequest, WorkerResponse } from '../../shared/models/tree-node.model';
import { layoutTree } from './tree-layout-engine';

addEventListener('message', ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    const response: WorkerResponse = {
      result: {
        nodes: layoutTree(data.root, data.params),
        repoName: data.repoName,
        headRepoName: data.headRepoName,
        ref: data.ref,
        vsRef: data.vsRef,
        isDiff: data.isDiff ?? false,
        prNumber: null,
      },
    };
    postMessage(response);
  } catch (e) {
    const response: WorkerResponse = {
      result: { nodes: [], repoName: data.repoName, headRepoName: data.headRepoName, ref: data.ref, vsRef: data.vsRef, isDiff: false, prNumber: null },
      error: e instanceof Error ? e.message : String(e),
    };
    postMessage(response);
  }
});
