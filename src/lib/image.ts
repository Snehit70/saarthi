import type { MonitorInfo, WindowInfo } from "./types.js";

export function parsePngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) throw new Error("Invalid PNG data");
  const signature = buf.subarray(0, 8);
  const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!signature.equals(pngSig)) throw new Error("Not a PNG image");

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

export function monitorWindowBounds(win: WindowInfo, monitors: MonitorInfo[]): MonitorInfo | null {
  const centerX = win.position.x + Math.floor(win.size.width / 2);
  const centerY = win.position.y + Math.floor(win.size.height / 2);
  return (
    monitors.find(
      (m) => centerX >= m.x && centerX < m.x + m.width && centerY >= m.y && centerY < m.y + m.height,
    ) ?? null
  );
}
