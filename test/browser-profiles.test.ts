import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it, expect, vi } from "vitest";
import {
  discoverBrowserProfiles,
  resolveBrowserProfile,
} from "../src/lib/browser-profiles.js";
afterEach(() => vi.unstubAllEnvs());
it("lists exact directories and names, rejects numeric guesses and prevents traversal from local metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "saarthi-profile-"));
  try {
    const browser = join(root, "net.imput.helium");
    await mkdir(browser);
    for (const name of ["Default", "Profile 3", "college"])
      await mkdir(join(browser, name));
    await writeFile(
      join(browser, "Local State"),
      JSON.stringify({
        profile: {
          last_used: "Default",
          info_cache: {
            Default: { name: "personal" },
            "Profile 3": { name: "other" },
            college: { name: "college" },
            "../escape": { name: "outside" },
            "Profile 1": { name: "stale" },
          },
        },
      }),
    );
    const profiles = await discoverBrowserProfiles("helium", root);
    expect(profiles).toHaveLength(3);
    expect(profiles.find((row) => row.directory === "Default")).toMatchObject({
      name: "personal",
      isLastUsed: true,
    });
    vi.stubEnv("XDG_CONFIG_HOME", root);
    expect((await resolveBrowserProfile("helium", "personal")).directory).toBe(
      "Default",
    );
    await expect(resolveBrowserProfile("helium", "1")).rejects.toThrow(
      /Unknown/,
    );
    await expect(resolveBrowserProfile("helium", "Profile 1")).rejects.toThrow(
      /Unknown/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects duplicate display names and profile symlinks rather than routing to an arbitrary profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "saarthi-profile-"));
  try {
    const browser = join(root, "net.imput.helium");
    await mkdir(browser);
    await mkdir(join(browser, "Default"));
    await mkdir(join(browser, "Profile 3"));
    await symlink(join(browser, "Default"), join(browser, "link"));
    await writeFile(
      join(browser, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: "same" },
            "Profile 3": { name: "same" },
            link: { name: "linked" },
          },
        },
      }),
    );
    vi.stubEnv("XDG_CONFIG_HOME", root);
    expect(await discoverBrowserProfiles("helium", root)).toHaveLength(2);
    await expect(resolveBrowserProfile("helium", "same")).rejects.toThrow(
      /ambiguous/,
    );
    expect((await resolveBrowserProfile("helium", "Default")).directory).toBe(
      "Default",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
