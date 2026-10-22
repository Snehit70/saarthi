import { mkdtemp, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readPrivateJson } from "../src/lib/private-json.js";
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "saarthi-private-json-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it("reads a private owned plan and rejects a publicly readable plan", async () => {
  const path = join(root,"plan.json"); await writeFile(path,'{"steps":[]}',{mode:0o600});
  expect(await readPrivateJson(path)).toEqual({steps:[]});
  await chmod(path,0o644);
  await expect(readPrivateJson(path)).rejects.toMatchObject({code:"INPUT_FAILED"});
});
it("rejects symlinks and oversized plans before parsing", async () => {
  const path = join(root,"plan.json"); await writeFile(path,Buffer.alloc(1024*1024+1),{mode:0o600});
  await expect(readPrivateJson(path)).rejects.toMatchObject({code:"INPUT_FAILED"});
  const link=join(root,"alias.json");await symlink(path,link);
  await expect(readPrivateJson(link)).rejects.toMatchObject({code:"ELOOP"});
});
