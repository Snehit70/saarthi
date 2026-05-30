import { describe, expect, it } from "vitest";
import { parseTesseractTsv } from "../src/lib/ocr.js";

// Tesseract TSV columns: level page block par line word left top width height conf text (12 cols)
const HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

function row(left: number, top: number, w: number, h: number, conf: number, text: string): string {
  return `5\t1\t1\t1\t1\t1\t${left}\t${top}\t${w}\t${h}\t${conf}\t${text}`;
}

describe("parseTesseractTsv", () => {
  it("returns empty for header-only or blank input", () => {
    expect(parseTesseractTsv("")).toEqual([]);
    expect(parseTesseractTsv(HEADER)).toEqual([]);
  });

  it("parses word rows into typed matches", () => {
    const tsv = [HEADER, row(10, 20, 30, 40, 95, "Submit")].join("\n");
    expect(parseTesseractTsv(tsv)).toEqual([
      { text: "Submit", x: 10, y: 20, width: 30, height: 40, confidence: 95 },
    ]);
  });

  it("skips rows with empty text or non-finite confidence", () => {
    const tsv = [
      HEADER,
      row(0, 0, 5, 5, -1, "   "), // blank text after trim
      "5\t1\t1\t1\t1\t1\t0\t0\t5\t5\tnan\tOK", // non-numeric conf
      row(1, 2, 3, 4, 80, "Real"),
    ].join("\n");
    expect(parseTesseractTsv(tsv)).toEqual([
      { text: "Real", x: 1, y: 2, width: 3, height: 4, confidence: 80 },
    ]);
  });

  it("ignores malformed rows with too few columns", () => {
    const tsv = [HEADER, "5\t1\t1\tincomplete", row(7, 8, 9, 10, 50, "Keep")].join("\n");
    expect(parseTesseractTsv(tsv)).toEqual([
      { text: "Keep", x: 7, y: 8, width: 9, height: 10, confidence: 50 },
    ]);
  });
});
