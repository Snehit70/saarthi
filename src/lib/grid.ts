import { HyprlandError } from "./hyprland.js";

export interface GridSpec {
  cols: number;
  rows: number;
}

export interface GridCellPoint {
  x: number;
  y: number;
  row: number;
  col: number;
}

export function defaultGridForSize(width: number): GridSpec {
  if (width < 1400) return { cols: 8, rows: 6 };
  if (width <= 2200) return { cols: 12, rows: 8 };
  return { cols: 16, rows: 10 };
}

export function cellToRelativePoint(
  cols: number,
  rows: number,
  width: number,
  height: number,
  cellId: number,
): GridCellPoint {
  const maxCell = cols * rows;
  if (!Number.isFinite(cellId) || cellId < 1 || cellId > maxCell) {
    throw new HyprlandError("NUMERIC_INVALID", `cellId must be within 1..${maxCell}`);
  }
  const idx = cellId - 1;
  const row = Math.floor(idx / cols);
  const col = idx % cols;
  const cellWidth = width / cols;
  const cellHeight = height / rows;
  const x = Math.floor(col * cellWidth + cellWidth / 2);
  const y = Math.floor(row * cellHeight + cellHeight / 2);
  return { x, y, row, col };
}

