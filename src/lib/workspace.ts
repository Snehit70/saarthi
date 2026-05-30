export interface WorkspaceBounds {
  min: number;
  max: number;
}

export function pickWorkspaceForMonitor(
  monitorName: string,
  workspaces: Array<{ name: string; id: number; monitor: string | null }>,
  occupiedWorkspaceNames: Set<string>,
  bounds: WorkspaceBounds,
): { name: string; created: boolean; exhausted: boolean } {
  const existing = workspaces
    .filter((w) => w.monitor === monitorName)
    .sort((a, b) => a.id - b.id);
  if (existing[0]) return { name: existing[0].name, created: false, exhausted: false };

  for (let i = bounds.min; i <= bounds.max; i += 1) {
    const candidate = String(i);
    if (!occupiedWorkspaceNames.has(candidate)) {
      return { name: candidate, created: true, exhausted: false };
    }
  }

  // All numeric workspace slots are occupied; caller should avoid claiming creation.
  return { name: String(bounds.min), created: false, exhausted: true };
}
