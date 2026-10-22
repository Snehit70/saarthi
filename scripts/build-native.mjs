import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist/native");
mkdirSync(output, { recursive: true });
let flags;
try {
  execFileSync("cc", ["--version"], { stdio: "ignore" });
  execFileSync("wayland-scanner", ["--version"], { stdio: "ignore" });
  flags = execFileSync("pkg-config", ["--cflags", "--libs", "wayland-client"], { encoding: "utf8" })
    .trim()
    .split(/\s+/);
} catch (error) {
  if (process.env.SAARTHI_REQUIRE_NATIVE === "1") throw error;
  process.stderr.write("Native capture helper unavailable. Install a C compiler, pkg-config, wayland-scanner and Wayland development headers, then run bun run build:native.\n");
  process.exit(0);
}
// Once prerequisites exist, scanner/compiler failures must fail the build.
{
  const protocols = readdirSync(join(root, "native/protocols")).filter((name) => name.endsWith(".xml"));
  const sources = [];
  for (const protocol of protocols) {
    const name = protocol.slice(0, -4);
    const input = join(root, "native/protocols", protocol);
    execFileSync("wayland-scanner", ["client-header", input, join(output, `${name}-client-protocol.h`)]);
    const source = join(output, `${name}-protocol.c`);
    execFileSync("wayland-scanner", ["private-code", input, source]);
    sources.push(source);
  }
  execFileSync(
    "cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      output,
      join(root, "native/toplevels.c"),
      ...sources,
      ...flags,
      "-o",
      join(output, "toplevels"),
    ],
    { stdio: "inherit" },
  );
  process.stdout.write("Built native window capture mapping helper\n");
}
