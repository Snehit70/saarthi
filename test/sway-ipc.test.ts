import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { swayRequest } from "../src/lib/sway-ipc.js";
async function fixture(
  response: (socket: Socket, request: Buffer) => void,
  operation: (path: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "saarthi-ipc-test-"));
  const path = join(root, "ipc.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", (data) => response(socket, data));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    await operation(path);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
it("parses fragmented native IPC frames and sends the requested type", async () => {
  await fixture(
    (socket, request) => {
      expect(request.toString("ascii", 0, 6)).toBe("i3-ipc");
      expect(request.readUInt32LE(10)).toBe(3);
      const body = Buffer.from('[{"name":"HEADLESS-1"}]');
      const header = Buffer.alloc(14);
      header.write("i3-ipc");
      header.writeUInt32LE(body.length, 6);
      header.writeUInt32LE(3, 10);
      socket.write(header.subarray(0, 8));
      setTimeout(
        () => socket.end(Buffer.concat([header.subarray(8), body])),
        5,
      );
    },
    async (path) => {
      expect(await swayRequest(path, 3)).toEqual([{ name: "HEADLESS-1" }]);
    },
  );
});
it("rejects oversized frames and never falls back to another socket", async () => {
  await fixture(
    (socket) => {
      const header = Buffer.alloc(14);
      header.write("i3-ipc");
      header.writeUInt32LE(5 * 1024 * 1024, 6);
      header.writeUInt32LE(4, 10);
      socket.end(header);
    },
    async (path) => {
      await expect(swayRequest(path, 4)).rejects.toThrow(/4 MiB/);
      await expect(swayRequest(path + "-missing", 4)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
