import { describe, expect, it } from "vitest";
import { cellToRelativePoint, defaultGridForSize } from "../src/lib/grid.js";

describe("defaultGridForSize", () => {
  it("returns compact grid for small widths", () => {
    expect(defaultGridForSize(1200)).toEqual({ cols: 8, rows: 6 });
  });

  it("returns medium grid for common laptop widths", () => {
    expect(defaultGridForSize(1863)).toEqual({ cols: 12, rows: 8 });
  });

  it("returns dense grid for large widths", () => {
    expect(defaultGridForSize(2560)).toEqual({ cols: 16, rows: 10 });
  });
});

describe("cellToRelativePoint", () => {
  it("maps first and last cells correctly", () => {
    const first = cellToRelativePoint(12, 8, 1863, 1026, 1);
    expect(first.row).toBe(0);
    expect(first.col).toBe(0);
    const last = cellToRelativePoint(12, 8, 1863, 1026, 96);
    expect(last.row).toBe(7);
    expect(last.col).toBe(11);
  });

  it("throws for out-of-range cell id", () => {
    expect(() => cellToRelativePoint(12, 8, 1863, 1026, 0)).toThrow("cellId must be within 1..96");
    expect(() => cellToRelativePoint(12, 8, 1863, 1026, 97)).toThrow("cellId must be within 1..96");
  });
});

