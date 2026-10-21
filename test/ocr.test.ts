import { describe, expect, it } from "vitest";
import { findTesseractMatches, parseTesseractTsv } from "../src/lib/ocr.js";

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
    expect(parseTesseractTsv(tsv)).toEqual([{ text: "Submit", x: 10, y: 20, width: 30, height: 40, confidence: 95 }]);
  });

  it("skips rows with empty text or non-finite confidence", () => {
    const tsv = [
      HEADER,
      row(0, 0, 5, 5, -1, "   "), // blank text after trim
      "5\t1\t1\t1\t1\t1\t0\t0\t5\t5\tnan\tOK", // non-numeric conf
      row(1, 2, 3, 4, 80, "Real"),
    ].join("\n");
    expect(parseTesseractTsv(tsv)).toEqual([{ text: "Real", x: 1, y: 2, width: 3, height: 4, confidence: 80 }]);
  });

  it("ignores malformed rows with too few columns", () => {
    const tsv = [HEADER, "5\t1\t1\tincomplete", row(7, 8, 9, 10, 50, "Keep")].join("\n");
    expect(parseTesseractTsv(tsv)).toEqual([{ text: "Keep", x: 7, y: 8, width: 9, height: 10, confidence: 50 }]);
  });
});

describe("OCR phrase matching", () => {
  const phrase = [HEADER, row(10, 20, 30, 20, 95, "Sign"), row(45, 20, 15, 20, 90, "in")].join("\n");
  it("joins adjacent words on the same line into a clickable bounding box", () => {
    expect(findTesseractMatches(phrase, " SIGN   IN ", 80)).toEqual([
      { text: "Sign in", x: 10, y: 20, width: 50, height: 20, confidence: 90 },
    ]);
  });
  it("preserves single-word substring searches", () => {
    expect(findTesseractMatches(phrase, "sig", 80)).toMatchObject([{ text: "Sign" }]);
  });
  it("does not join words across lines, distant controls, or low confidence words", () => {
    expect(findTesseractMatches(phrase.replace("5\t1\t1\t1\t1\t1\t45", "5\t1\t1\t1\t2\t1\t45"), "Sign in", 80)).toEqual(
      [],
    );
    expect(
      findTesseractMatches(
        [HEADER, row(10, 20, 30, 20, 95, "Sign"), row(500, 20, 15, 20, 90, "in")].join("\n"),
        "Sign in",
        80,
      ),
    ).toEqual([]);
    expect(findTesseractMatches(phrase, "Sign in", 91)).toEqual([]);
  });
  it("rejects malformed geometry and invalid confidence", () => {
    expect(
      parseTesseractTsv(
        [HEADER, row(NaN, 20, 30, 20, 95, "Bad"), row(10, 20, -1, 20, 95, "Bad"), row(10, 20, 30, 20, -1, "Bad")].join(
          "\n",
        ),
      ),
    ).toEqual([]);
  });
});
