// Document ingest: text, PDF (pdftotext), EPUB (unzip + tag strip) from raw
// text, relay-local paths, or http(s) URLs. Output is plain text in the same
// TranscriptResult-adjacent shape transcription produces.

import type { RelayConfig } from "./config.ts";

export interface IngestSource {
  kind: "text" | "path" | "url";
  value: string;
  filename?: string;
}

export interface IngestResult {
  format: "txt" | "md" | "epub" | "pdf";
  title: string | null;
  text: string;
  chars: number;
}

const MAX_DOC_BYTES = 100 * 1024 * 1024;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(p|div|h[1-6]|li|br|tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

async function unzipRead(unzipBin: string, epub: string, member: string): Promise<string> {
  const cmd = new Deno.Command(unzipBin, { args: ["-p", epub, member], stdout: "piped", stderr: "null" });
  const out = await cmd.output();
  if (!out.success) throw new Error(`epub member missing: ${member}`);
  return new TextDecoder().decode(out.stdout);
}

async function epubToText(unzipBin: string, epub: string): Promise<{ title: string | null; text: string }> {
  const container = await unzipRead(unzipBin, epub, "META-INF/container.xml");
  const opfPath = container.match(/full-path=(["'])(.*?)\1/i)?.[2];
  if (!opfPath) throw new Error("epub container.xml has no rootfile");
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const opf = await unzipRead(unzipBin, epub, opfPath);
  const title = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1].trim() ?? null;
  const manifest: Record<string, string> = {};
  for (const m of opf.matchAll(/<item[^>]*?id=(["'])(.*?)\1[^>]*?href=(["'])(.*?)\3[^>]*?>/gi)) {
    manifest[m[2]] = m[4];
  }
  const spine = [...opf.matchAll(/<itemref[^>]*?idref=(["'])(.*?)\1[^>]*?>/gi)]
    .map((m) => manifest[m[2]])
    .filter((h): h is string => !!h)
    .slice(0, 500);
  const parts: string[] = [];
  for (const href of spine) {
    try {
      parts.push(stripHtml(await unzipRead(unzipBin, epub, base + href)));
    } catch {
      // skip unreadable spine items, keep the rest
    }
  }
  return { title, text: parts.join("\n\n") };
}

export async function runIngest(cfg: RelayConfig, src: IngestSource, signal: AbortSignal): Promise<IngestResult> {
  let bytes: Uint8Array;
  let name = src.filename ?? "input.txt";
  if (src.kind === "text") {
    bytes = new TextEncoder().encode(src.value);
  } else if (src.kind === "path") {
    const st = await Deno.stat(src.value);
    if (!st.isFile || (st.size ?? 0) > MAX_DOC_BYTES) throw new Error("path is not a file or exceeds 100 MiB");
    name = src.filename ?? src.value.split("/").pop() ?? name;
    bytes = await Deno.readFile(src.value);
  } else {
    const url = new URL(src.value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs are fetchable");
    const res = await fetch(src.value, { signal });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > MAX_DOC_BYTES) throw new Error("download exceeds 100 MiB cap");
      chunks.push(chunk);
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    bytes = merged;
    name = src.filename ?? url.pathname.split("/").pop() ?? name;
  }
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "pdf") {
    if (!cfg.pdftotextBin) throw new Error("pdftotext not installed on relay host");
    const tmp = await Deno.makeTempFile({ prefix: "mcu-doc-", suffix: ".pdf" });
    try {
      await Deno.writeFile(tmp, bytes);
      const cmd = new Deno.Command(cfg.pdftotextBin, { args: ["-layout", tmp, "-"], stdout: "piped", stderr: "piped" });
      const out = await cmd.output();
      if (!out.success) throw new Error(`pdftotext failed: ${new TextDecoder().decode(out.stderr).slice(0, 300)}`);
      const text = new TextDecoder().decode(out.stdout).replace(/[ \t]+\n/g, "\n").trim();
      const title = text.split("\n").map((l) => l.trim()).find((l) => l !== "")?.slice(0, 200) ?? null;
      return { format: "pdf", title, text, chars: text.length };
    } finally {
      await Deno.remove(tmp).catch(() => {});
    }
  }
  if (ext === "epub") {
    if (!cfg.unzipBin) throw new Error("unzip not installed on relay host");
    const tmp = await Deno.makeTempFile({ prefix: "mcu-doc-", suffix: ".epub" });
    try {
      await Deno.writeFile(tmp, bytes);
      const { title, text } = await epubToText(cfg.unzipBin, tmp);
      return { format: "epub", title, text: text.trim(), chars: text.trim().length };
    } finally {
      await Deno.remove(tmp).catch(() => {});
    }
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
  return { format: ext === "md" ? "md" : "txt", title: null, text, chars: text.length };
}
