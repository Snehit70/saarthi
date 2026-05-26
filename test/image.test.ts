import { describe, expect, it } from "vitest";
import { parsePngDimensions } from "../src/lib/image.js";

function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33, 0);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  Buffer.from("IHDR").copy(buf, 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("parsePngDimensions", () => {
  it("reads dimensions", () => {
    const png = makePng(1920, 1080);
    expect(parsePngDimensions(png)).toEqual({ width: 1920, height: 1080 });
  });

  it("rejects invalid header", () => {
    const bad = Buffer.alloc(24, 0);
    expect(() => parsePngDimensions(bad)).toThrow("Not a PNG image");
  });
});
