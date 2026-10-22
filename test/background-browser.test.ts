import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackgroundBrowser, validateBrowserStep } from "../src/lib/background-browser.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "saarthi-browser-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const step = (args = {}) => validateBrowserStep({ tabId: 42, expectedUrl: "https://example.com/", action: "read", ...args });
function setup() {
  const client = { getTabs: vi.fn(async () => [{ id: 42 }]), attach: vi.fn(async () => ({})), executeCdp: vi.fn(), finalizeTabs: vi.fn() };
  const browser = new BackgroundBrowser(client as never);
  return { client, browser };
}
it("rejects unsupported schemes, ambiguous ownership and unconfirmed declared submissions", async () => {
  for (const expectedUrl of ["javascript:alert(1)", "chrome://settings", "https://user:pass@example.com/"])
    expect(() => step({ expectedUrl })).toThrow();
  expect(() => step({ action: "click", selector: "#continue", actionKind: "submit" })).toThrow(/confirmation/);
  const { client, browser } = setup();
  await expect(browser.act(step({ tabId: 99 }))).rejects.toThrow(/outside/);
  expect(client.executeCdp).not.toHaveBeenCalled();
});
it("stops on page-side URL or selector failure without another action", async () => {
  const { client, browser } = setup();
  client.executeCdp.mockResolvedValue({ exceptionDetails: { exception: { description: "Page URL changed" } } });
  await expect(browser.act(step({ action: "fill", selector: "#name", text: "safe" }))).rejects.toThrow(/URL changed/);
  expect(client.executeCdp).toHaveBeenCalledTimes(1);
});
it("rejects multiple uploads to a single-file control before setting files", async () => {
  const { client, browser } = setup();
  const paths = [join(root, "a.txt"), join(root, "b.txt")];
  await Promise.all(paths.map(path => writeFile(path, "file")));
  client.executeCdp.mockResolvedValue({ result: { value: { multiple: false, files: [] } } });
  await expect(browser.act(step({ action: "files", selector: "#files", files: paths }))).rejects.toThrow(/multiple/);
  expect(client.executeCdp.mock.calls.some(call => call[1] === "DOM.setFileInputFiles")).toBe(false);
});
it("sets exact files once, checks file-list readback, and leaves application verification pending", async () => {
  const { client, browser } = setup();
  const path = join(root, "a.txt"); await writeFile(path, "file");
  let attached = false;
  client.executeCdp.mockImplementation(async (_tabId, method, params) => {
    if (params.expression.includes('"op":"')) {
      if ((params.expression.includes('"op":"attach"') || params.expression.includes('"op":"bundle"'))) attached = true;
      return { result: { value: true } };
    }
    // The native bridge serializes object keys in a different order.
    return { result: { value: { multiple: false, files: attached ? [{ bytes: 4, name: "a.txt" }] : [] } } };
  });
  expect(await browser.act(step({ action: "files", selector: "#files", files: [path] }))).toMatchObject({ verifiedFileList: true, verificationRequired: true });
  expect(client.executeCdp.mock.calls.filter(call => (call[2]?.expression?.includes('"op":"attach"') || call[2]?.expression?.includes('"op":"bundle"')))).toHaveLength(1);
  expect(client.executeCdp.mock.calls.every(call => !String(call[1]).includes("focus"))).toBe(true);
});
it("refuses a mismatched file list and never replays the attachment", async () => {
  const { client, browser } = setup();
  const path = join(root, "a.txt"); await writeFile(path, "file");
  client.executeCdp.mockImplementation(async (_tabId, method, params) => {
    if (params.expression.includes('"op":"')) return { result: { value: true } };
    return { result: { value: { multiple: false, files: [] } } };
  });
  await expect(browser.act(step({ action: "files", selector: "#files", files: [path] }))).rejects.toThrow(/did not match/);
  expect(client.executeCdp.mock.calls.filter(call => (call[2]?.expression?.includes('"op":"attach"') || call[2]?.expression?.includes('"op":"bundle"')))).toHaveLength(1);
});
it("never finalizes tabs outside the current session", async () => {
  const { client, browser } = setup();
  await expect(browser.finish([99])).rejects.toThrow(/owned/);
  expect(client.finalizeTabs).not.toHaveBeenCalled();
});
it("classifies screenshot timeouts without replaying the request", async () => {
  const { client, browser } = setup();
  client.executeCdp.mockResolvedValueOnce({ result: { value: { text:"page" } } }).mockRejectedValueOnce(new Error("Timed out after 10000ms waiting for CDP command"));
  await expect(browser.act(step({action:"screenshot"}))).rejects.toMatchObject({code:"ACTION_TIMEOUT"});
  expect(client.executeCdp.mock.calls.filter(call=>call[1]==="Page.captureScreenshot")).toHaveLength(1);
});
