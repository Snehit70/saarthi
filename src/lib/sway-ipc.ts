import { createConnection } from "node:net";

/** Client of one explicitly selected private compositor. Never discovers or
 * falls back to the user's desktop socket. No caller-facing raw command API. */
export function swayRequest(
  path: string,
  type: 0 | 3 | 4 | 7 | 100 | 101,
  payload = "",
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const deadline = setTimeout(
      () => finish(new Error("Private compositor IPC timed out")),
      3000,
    );
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(3000, () =>
      finish(new Error("Private compositor IPC timed out")),
    );
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled)
        finish(new Error("Private compositor closed an incomplete response"));
    });
    socket.on("connect", () => {
      const body = Buffer.from(payload);
      const header = Buffer.alloc(14);
      header.write("i3-ipc", 0, "ascii");
      header.writeUInt32LE(body.length, 6);
      header.writeUInt32LE(type, 10);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on("data", (chunk) => {
      if (data.length + chunk.length > 4 * 1024 * 1024 + 14)
        return finish(new Error("Private compositor response exceeds 4 MiB"));
      data = Buffer.concat([data, chunk]);
      if (data.length < 14) return;
      if (
        data.toString("ascii", 0, 6) !== "i3-ipc" ||
        data.readUInt32LE(10) !== type
      )
        return finish(new Error("Unexpected private compositor response"));
      const length = data.readUInt32LE(6);
      if (length > 4 * 1024 * 1024)
        return finish(new Error("Private compositor response exceeds 4 MiB"));
      if (data.length < length + 14) return;
      if (data.length !== length + 14)
        return finish(new Error("Trailing private compositor data"));
      try {
        finish(undefined, JSON.parse(data.subarray(14).toString("utf8")));
      } catch {
        finish(new Error("Invalid private compositor JSON"));
      }
    });
  });
}
