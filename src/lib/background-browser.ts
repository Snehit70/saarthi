import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath, stat, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, extname } from "node:path";
import { OpenBrowserUseClient, type BrowserUseRequestParams } from "open-browser-use-sdk";
import { z } from "zod";
import { HyprlandError } from "./hyprland.js";

const run = promisify(execFile);
export const browserConnectionShape = {
  browserTarget: z.string().min(1).max(80),
  profile: z.string().min(1).max(100),
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/),
};
export type BrowserConnection = z.infer<z.ZodObject<typeof browserConnectionShape>>;
export const browserStepSchema = z
  .object({
    tabId: z.number().int().positive(),
    expectedUrl: z.string().min(1).max(8192),
    action: z.enum(["inspect", "read", "fill", "click", "files", "wait-text", "screenshot"]),
    selector: z.string().min(1).max(1000).optional(),
    text: z.string().max(100000).optional(),
    files: z.array(z.string().min(1).max(4096)).min(1).max(20).optional(),
    timeoutMs: z.number().int().min(0).max(30000).default(5000),
    confirmed: z.boolean().default(false),
    actionKind: z.enum(["edit", "navigate", "send", "submit", "delete", "payment"]).default("edit"),
  })
  .strict();
export type BrowserStep = z.infer<typeof browserStepSchema>;

export function allowedPageUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || !(["https:", "http:", "file:"].includes(url.protocol) || value === "about:blank"))
    throw new HyprlandError("INPUT_FAILED", "Only explicit http, https, file, or about:blank page URLs are supported");
  return url.href;
}
export function validateBrowserStep(value: unknown): BrowserStep {
  const step = browserStepSchema.parse(value);
  step.expectedUrl = allowedPageUrl(step.expectedUrl);
  if (["fill", "click", "files"].includes(step.action) && !step.selector)
    throw new HyprlandError("INPUT_FAILED", "This action requires an exact selector");
  if (["fill", "wait-text"].includes(step.action) && step.text === undefined)
    throw new HyprlandError("INPUT_FAILED", "This action requires text");
  if (step.action !== "fill" && step.action !== "wait-text" && step.text !== undefined)
    throw new HyprlandError("INPUT_FAILED", "Only fill and wait-text accept text");
  if ((step.action === "files") !== Boolean(step.files))
    throw new HyprlandError("INPUT_FAILED", "Only files actions accept and require explicit file paths");
  if (step.action === "click" && !step.confirmed && ["send", "submit", "delete", "payment"].includes(step.actionKind))
    throw new HyprlandError("INPUT_FAILED", "This browser action requires confirmation");
  return step;
}

// This fixed program accepts JSON data, never caller-supplied JavaScript.
// It does not activate a tab, focus a field, or inject desktop input.
const elementProgram = String.raw`async (args) => {
  if (location.href !== args.expectedUrl) throw new Error("Page URL changed; inspect before acting");
  if (args.action === "inspect") {
    let root=document;
    if(args.selector){const targets=document.querySelectorAll(args.selector);if(targets.length!==1)throw new Error("Inspect scope must be unique");root=targets[0];}
    const candidates=root.querySelectorAll('input,textarea,select,button,a[href],[contenteditable="true"],[role="button"]');
    const elements=[];
    for(const node of candidates){
      if(elements.length===200)break;
      const style=getComputedStyle(node);const hidden=!node.getClientRects().length||style.display==="none"||style.visibility==="hidden";
      if(hidden&&!(node instanceof HTMLInputElement&&node.type==="file"))continue;
      let selector=node.id ? '#'+CSS.escape(node.id) : '';
      if(!selector||document.querySelectorAll(selector).length!==1){
        const parts=[];let current=node;
        for(let i=0;current&&i<12;i++,current=current.parentElement){
          const tag=current.localName;const siblings=current.parentElement?Array.from(current.parentElement.children).filter(el=>el.localName===tag):[current];
          parts.unshift(tag+':nth-of-type('+(siblings.indexOf(current)+1)+')');
        }
        selector=parts.join(' > ');
      }
      if(document.querySelectorAll(selector).length!==1)continue;
      elements.push({selector,tag:node.localName,type:node.type||null,name:String(node.getAttribute('aria-label')||node.labels?.[0]?.textContent||node.textContent||node.getAttribute('placeholder')||node.getAttribute('title')||'').trim().slice(0,200),disabled:Boolean(node.disabled)||node.getAttribute('aria-disabled')==='true',hidden,multiple:Boolean(node.multiple)});
    }
    return {url:location.href,title:document.title,elements,limit:200,truncated:candidates.length>elements.length,text:(document.body?.innerText||'').slice(0,100000)};
  }
  if (!args.selector) return {url:location.href,title:document.title,text:(document.body?.innerText || "").slice(0,100000)};
  const matches = document.querySelectorAll(args.selector);
  if (matches.length !== 1) throw new Error("Selector must resolve exactly one element");
  const node = matches[0];
  if (!(node instanceof HTMLElement)) throw new Error("Target is not an HTML element");
  const style = getComputedStyle(node);
  if ((args.action !== "files" && (!node.getClientRects().length || style.display === "none" || style.visibility === "hidden")) || node.disabled || node.getAttribute("aria-disabled") === "true")
    throw new Error("Target is not available");
  if (node instanceof HTMLInputElement && node.type === "password") throw new Error("Password fields are not supported");
  const name = node.getAttribute("aria-label") || node.labels?.[0]?.textContent || node.textContent || node.getAttribute("title") || "";
  if (args.action === "click") {
    if (!args.confirmed && /^(send|submit|publish|pay|purchase|delete|remove)\b/i.test(name.trim())) throw new Error("This control requires confirmation");
    if (!args.confirmed && node.form && (node.type === "submit" || node.type === "image")) throw new Error("Form submission requires confirmation");
    if (node instanceof HTMLInputElement && node.type === "file") throw new Error("Use a files action instead of opening a native chooser");
    if (node instanceof HTMLLabelElement && node.control?.type === "file") throw new Error("Use a files action instead of opening a native chooser");
    node.click(); return {clicked:true,verificationRequired:true};
  }
  if (args.action === "fill") {
    if ((node instanceof HTMLInputElement && !["text","search","url","tel","email","number"].includes(node.type)) || node.readOnly) throw new Error("Target does not accept text replacement");
    const proto = node instanceof HTMLInputElement ? HTMLInputElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : null;
    if (proto) Object.getOwnPropertyDescriptor(proto,"value").set.call(node,args.text);
    else if (node.isContentEditable) node.textContent = args.text;
    else throw new Error("Target is not editable");
    node.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:args.text}));
    node.dispatchEvent(new Event("change",{bubbles:true}));
    if ((proto ? node.value : node.textContent) !== args.text) throw new Error("Text readback did not match");
    return {textLength:args.text.length,verified:true,verificationRequired:true};
  }
  if (args.action === "files") {
    if (!(node instanceof HTMLInputElement) || node.type !== "file") throw new Error("Target is not a file input");
    return {multiple:node.multiple,files:Array.from(node.files).map(file=>({name:file.name,bytes:file.size}))};
  }
  return {url:location.href,title:document.title,text:String("value" in node ? node.value : node.innerText || "").slice(0,100000)};
}`;

// Explicit file bytes cross the socket, never subprocess argv. No extension
// permission change or native chooser is needed. Stage all files before the
// single file-list assignment; interrupted staging never partially attaches.
const fileProgram = String.raw`(args) => {
  if (args.op === "cleanup") { delete globalThis[args.key]; return true; }
  if (location.href !== args.expectedUrl) throw new Error("Page URL changed during file transfer");
  if (args.op === "begin") { globalThis[args.key] = {files:[],parts:[],bytes:0}; return true; }
  if (args.op === "bundle") {
    const files=args.files.map(file=>{
      const raw=atob(file.base64);if(raw.length!==file.bytes)throw new Error("File length mismatch");
      const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
      return new File([bytes],file.name,{type:file.mime,lastModified:file.lastModified});
    });
    globalThis[args.key]={files,parts:[],bytes:0};args.op="attach";
  }
  const state = globalThis[args.key];
  if (!state) throw new Error("File transfer state was lost; inspect before retrying");
  if (args.op === "chunk") {
    const raw=atob(args.base64);const bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    state.parts.push(bytes);state.bytes+=bytes.length;return true;
  }
  if (args.op === "file") {
    if(state.bytes !== args.bytes)throw new Error("Transferred file length did not match");
    state.files.push(new File(state.parts,args.name,{type:args.mime,lastModified:args.lastModified}));
    state.parts=[];state.bytes=0;return true;
  }
  if (args.op !== "attach") throw new Error("Unsupported file transfer operation");
  const matches=document.querySelectorAll(args.selector);
  if(matches.length!==1)throw new Error("File selector changed during transfer");
  const node=matches[0];
  if(!(node instanceof HTMLInputElement)||node.type!=="file"||node.disabled||node.getAttribute("aria-disabled")==="true")throw new Error("File input is no longer available");
  if(state.files.length>1&&!node.multiple)throw new Error("File input no longer accepts multiple files");
  const data=new DataTransfer();for(const file of state.files)data.items.add(file);
  node.files=data.files;delete globalThis[args.key];
  node.dispatchEvent(new Event("input",{bubbles:true}));node.dispatchEvent(new Event("change",{bubbles:true}));
  return true;
}`;
const mimeTypes: Record<string, string> = {
  ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".gif":"image/gif",
  ".pdf":"application/pdf", ".txt":"text/plain", ".csv":"text/csv", ".json":"application/json",
  ".md":"text/markdown", ".zip":"application/zip", ".svg":"image/svg+xml",
};

export class BackgroundBrowser {
  private readonly attachedTabs = new Set<number>();
  constructor(readonly client: OpenBrowserUseClient) {}

  static async connect(options: BrowserConnection): Promise<BackgroundBrowser> {
    const { stdout } = await run("open-browser-use", ["profiles", "--connected", "--json"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const profiles = z
      .array(
        z.object({
          browser: z.string(),
          directory: z.string(),
          connected: z.boolean().optional(),
          socketPath: z.string().optional(),
        }),
      )
      .parse(JSON.parse(stdout));
    const matches = profiles.filter(
      (row) =>
        row.connected && row.browser === options.browserTarget && row.directory === options.profile && row.socketPath,
    );
    if (matches.length !== 1)
      throw new HyprlandError(
        "INPUT_FAILED",
        "Select exactly one connected browser/profile; no browser was launched or profile changed",
      );
    const socketPath = matches[0].socketPath!;
    const socket = await lstat(socketPath);
    if (!socket.isSocket() || socket.uid !== process.getuid?.())
      throw new HyprlandError("INPUT_FAILED", "Browser socket is not owned by the current user");
    const client = new OpenBrowserUseClient({ socketPath, sessionId: options.sessionId, timeoutMs: 15000 });
    try {
      await client.connect();
      return new BackgroundBrowser(client);
    } catch (error) {
      client.close();
      throw error;
    }
  }
  close(): void {
    this.client.close();
  }
  async tabs(): Promise<Array<{ id: number; url?: string; title?: string }>> {
    return z
      .array(z.object({ id: z.number().int().positive(), url: z.string().optional(), title: z.string().optional() }))
      .parse(await this.client.getTabs());
  }
  async assertOwned(tabId: number): Promise<void> {
    if (!(await this.tabs()).some((tab) => tab.id === tabId))
      throw new HyprlandError("INPUT_FAILED", "Tab is outside this browser session");
  }
  async open(url: string, label: string): Promise<Record<string, unknown>> {
    const target = allowedPageUrl(url);
    await this.client.nameSession(`${label} - OBU`);
    const created = z.object({ id: z.number().int().positive() }).parse(await this.client.createTab());
    await this.assertOwned(created.id);
    if (target !== "about:blank") {
      const navigation = await this.cdp(created.id, "Page.navigate", { url: target });
      if (navigation.errorText) throw new HyprlandError("INPUT_FAILED", `Navigation failed in tab ${created.id}; inspect before retrying`);
    }
    return { tabId: created.id, requestedUrl: target, verificationRequired: true, viewMutationRequested: false };
  }
  async finish(keepTabIds: number[]): Promise<Record<string, unknown>> {
    const tabs = await this.tabs();
    if (new Set(keepTabIds).size !== keepTabIds.length || keepTabIds.some(id => !tabs.some(tab => tab.id === id)))
      throw new HyprlandError("INPUT_FAILED", "Only distinct tabs owned by this session may be kept");
    const result = await this.client.finalizeTabs(keepTabIds.map(tabId => ({ tabId, status: "handoff" })));
    return { result, keptTabIds: keepTabIds };
  }
  async cdp(tabId: number, method: string, params: BrowserUseRequestParams = {}): Promise<Record<string, any>> {
    if (!this.attachedTabs.has(tabId)) {
      await this.assertOwned(tabId);
      await this.client.attach(tabId);
      this.attachedTabs.add(tabId);
    }
    try {
      return (await this.client.executeCdp(tabId, method, params)) as Record<string, any>;
    } catch (error) {
      if (/timed out|timeout/i.test(error instanceof Error ? error.message : ""))
        throw new HyprlandError("ACTION_TIMEOUT", `${method} timed out; inspect before retrying`);
      throw error;
    }
  }
  async evaluate(step: BrowserStep): Promise<Record<string, any>> {
    const response = await this.cdp(step.tabId, "Runtime.evaluate", {
      expression: `(${elementProgram})(${JSON.stringify(step)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails)
      throw new HyprlandError(
        "INPUT_FAILED",
        response.exceptionDetails.exception?.description?.slice(0, 1000) || "Browser action failed",
      );
    return z.record(z.unknown()).parse(response.result?.value);
  }
  private async transferFiles(step: BrowserStep, paths: string[]): Promise<void> {
    const key = `__saarthi_files_${randomBytes(16).toString("hex")}`;
    const call = async (args: Record<string, unknown>) => {
      const response = await this.cdp(step.tabId, "Runtime.evaluate", {
        expression: `(${fileProgram})(${JSON.stringify({ key, expectedUrl: step.expectedUrl, selector: step.selector, ...args })})`,
        returnByValue: true,
      });
      if (response.exceptionDetails || response.result?.value !== true)
        throw new HyprlandError("INPUT_FAILED", "Browser file transfer failed; inspect before retrying");
    };
    try {
      const sizes = await Promise.all(paths.map(path => stat(path)));
      if (sizes.reduce((sum, file) => sum + file.size, 0) <= 192 * 1024) {
        const bundle = [];
        let total = 0;
        for (const path of paths) {
          const file = await open(path, "r");
          try {
            const before = await file.stat();
            if (!before.isFile() || total + before.size > 192 * 1024)
              throw new HyprlandError("INPUT_FAILED", "File changed before transfer");
            const data = Buffer.alloc(before.size + 1);
            let length = 0;
            while (length < data.length) {
              const { bytesRead } = await file.read(data, length, data.length - length, null);
              if (!bytesRead) break;
              length += bytesRead;
            }
            const after = await file.stat();
            if (length !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
              throw new HyprlandError("INPUT_FAILED", "File changed during transfer");
            total += length;
            bundle.push({ name: basename(path), bytes: length, lastModified: before.mtimeMs,
              mime: mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream", base64: data.subarray(0, length).toString("base64") });
          } finally { await file.close(); }
        }
        await call({ op: "bundle", files: bundle });
        return;
      }
      await call({ op: "begin" });
      let total = 0;
      for (const path of paths) {
        const file = await open(path, "r");
        try {
          const before = await file.stat();
          if (!before.isFile() || total + before.size > 128 * 1024 * 1024)
            throw new HyprlandError("INPUT_FAILED", "Files changed or exceed the transfer size limit");
          const buffer = Buffer.alloc(192 * 1024);
          let bytes = 0;
          while (true) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            bytes += bytesRead;
            if (total + bytes > 128 * 1024 * 1024 || bytes > before.size)
              throw new HyprlandError("INPUT_FAILED", "File grew during transfer");
            await call({ op: "chunk", base64: buffer.subarray(0, bytesRead).toString("base64") });
          }
          const after = await file.stat();
          if (bytes !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
            throw new HyprlandError("INPUT_FAILED", "File changed during transfer");
          total += bytes;
          await call({ op: "file", name: basename(path), bytes, lastModified: before.mtimeMs,
            mime: mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream" });
        } finally { await file.close(); }
      }
      await call({ op: "attach" });
    } finally {
      // Cleanup has no input effect and must not hide an uncertain attach error.
      await call({ op: "cleanup" }).catch(() => {});
    }
  }
  async act(raw: BrowserStep): Promise<Record<string, any>> {
    const step = validateBrowserStep(raw);
    await this.assertOwned(step.tabId);
    if (step.action === "screenshot") {
      await this.evaluate({ ...step, action: "read", selector: undefined });
      const result = await this.cdp(step.tabId, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true });
      return {
        png: Buffer.from(
          z
            .string()
            .min(1)
            .max(36 * 1024 * 1024)
            .parse(result.data),
          "base64",
        ),
        verificationRequired: false,
      };
    }
    if (step.action === "files") {
      const paths = await Promise.all(step.files!.map((path) => realpath(path)));
      if (new Set(paths).size !== paths.length) throw new HyprlandError("INPUT_FAILED", "File paths must be distinct");
      const metadata = await Promise.all(paths.map((path) => stat(path)));
      if (
        metadata.some((file) => !file.isFile()) ||
        metadata.reduce((sum, file) => sum + file.size, 0) > 128 * 1024 * 1024
      )
        throw new HyprlandError("INPUT_FAILED", "Select regular files totalling at most 128 MiB");
      const target = await this.evaluate(step);
      if (paths.length > 1 && !target.multiple)
        throw new HyprlandError("INPUT_FAILED", "File input does not accept multiple files");
      await this.transferFiles(step, paths);
      const result = await this.evaluate(step);
      const expected = paths.map((path, index) => ({ name: basename(path), bytes: metadata[index].size }));
      const observed = z.array(z.object({ name: z.string(), bytes: z.number().int().nonnegative() })).parse(result.files);
      if (observed.length !== expected.length || observed.some((file, index) => file.name !== expected[index].name || file.bytes !== expected[index].bytes))
        throw new HyprlandError("INPUT_FAILED", "Selected file list did not match; inspect before retrying");
      return { files: expected, verifiedFileList: true, transferMethod: "explicit-file-bytes", verificationRequired: true };
    }
    if (step.action === "wait-text") {
      const deadline = Date.now() + step.timeoutMs;
      do {
        const result = await this.evaluate({ ...step, action: "read" });
        if (String(result.text).includes(step.text!)) return { ...result, matched: true };
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (true);
      throw new HyprlandError("ACTION_TIMEOUT", "Expected browser text was not observed; no action was replayed");
    }
    return this.evaluate(step);
  }
}
