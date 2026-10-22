import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { findFiles } from "../src/lib/file-discovery.js";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
it("returns exact image matches in natural order without trusting extensions or following external links", async () => {
  const root = await mkdtemp(join(tmpdir(), "saarthi-find-"));
  try {
    for (const name of ["Kavach_10.png", "kavach_2.png", "kavach_1.png"])
      await writeFile(join(root, name), png);
    await writeFile(join(root, "kavach_fake.png"), "not an image");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested/kavach_3.png"), png);
    await symlink(
      join(root, "nested/kavach_3.png"),
      join(root, "kavach_link.png"),
    );
    const result = await findFiles({
      directory: root,
      nameContains: "KAVACH",
      type: "image",
      maxDepth: 0,
      limit: 10,
      maxVisited: 50,
    });
    expect(result).toMatchObject({
      matches: 3,
      complete: true,
      truncated: false,
    });
    expect(
      (result.files as Array<{ name: string }>).map((file) => file.name),
    ).toEqual(["kavach_1.png", "kavach_2.png", "Kavach_10.png"]);
    const recursive = await findFiles({
      directory: root,
      nameContains: "kavach",
      type: "image",
      maxDepth: 1,
      limit: 10,
      maxVisited: 50,
    });
    expect(recursive.matches).toBe(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("reports incomplete searches and limited results rather than pretending they are all matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "saarthi-find-"));
  try {
    for (let i = 0; i < 4; i++)
      await writeFile(join(root, "kavach_" + i + ".png"), png);
    const result = await findFiles({
      directory: root,
      nameContains: "kavach",
      type: "image",
      maxDepth: 0,
      limit: 1,
      maxVisited: 2,
    });
    expect(result).toMatchObject({
      visited: 2,
      complete: false,
      truncated: true,
    });
    expect(result.files).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
