let gpuHolder: string | null = null;

export function tryAcquireGpu(runId: string): boolean {
  if (gpuHolder !== null && gpuHolder !== runId) {
    return false;
  }
  gpuHolder = runId;
  return true;
}

export function releaseGpu(runId: string): void {
  if (gpuHolder === runId) {
    gpuHolder = null;
  }
}

export function gpuHeldBy(): string | null {
  return gpuHolder;
}
