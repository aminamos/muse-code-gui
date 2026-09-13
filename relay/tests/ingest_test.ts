import { assert, assertEquals } from "@std/assert";
import { runIngest } from "../src/ingest.ts";
import type { RelayConfig } from "../src/config.ts";

const CFG = {
  pdftotextBin: "pdftotext",
  unzipBin: "unzip",
} as RelayConfig;

// Minimal stored (uncompressed) zip writer for epub fixtures.
function crc32(data: Uint8Array): number {
  let table: number[] | null = null;
  const get = (): number[] => {
    if (table) return table;
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  };
  const t = get();
  let crc = 0xffffffff;
  for (const b of data) crc = t[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: Array<[string, string]>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(8, 0, true);
    head.setUint32(14, crc32(data), true);
    head.setUint32(18, data.byteLength, true);
    head.setUint32(22, data.byteLength, true);
    head.setUint16(26, nameBytes.byteLength, true);
    const local = new Uint8Array(30 + nameBytes.byteLength + data.byteLength);
    local.set(new Uint8Array(head.buffer), 0);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.byteLength);
    chunks.push(local);
    const chead = new DataView(new ArrayBuffer(46));
    chead.setUint32(0, 0x02014b50, true);
    chead.setUint32(16, crc32(data), true);
    chead.setUint32(20, data.byteLength, true);
    chead.setUint32(24, data.byteLength, true);
    chead.setUint16(28, nameBytes.byteLength, true);
    chead.setUint32(42, offset, true);
    const rec = new Uint8Array(46 + nameBytes.byteLength);
    rec.set(new Uint8Array(chead.buffer), 0);
    rec.set(nameBytes, 46);
    central.push(rec);
    offset += local.byteLength;
  }
  const centralStart = offset;
  const centralAll = central.reduce((a, b) => {
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a, 0);
    out.set(b, a.byteLength);
    return out;
  }, new Uint8Array(0));
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralAll.byteLength, true);
  end.setUint32(16, centralStart, true);
  const total = offset + centralAll.byteLength + 22;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of [...chunks, centralAll, new Uint8Array(end.buffer)]) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

const OPF = `<?xml version="1.0"?><package><metadata><dc:title>Test Book</dc:title></metadata>
<manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest>
<spine><itemref idref="b"/><itemref idref="a"/></spine></package>`;
const CONTAINER = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`;

Deno.test("ingest: inline text", async () => {
  const r = await runIngest(CFG, { kind: "text", value: "  hello\n" }, AbortSignal.timeout(5000));
  assertEquals(r, { format: "txt", title: null, text: "hello", chars: 5 });
});

Deno.test("ingest: epub spine order + title", async () => {
  const zip = buildZip([
    ["META-INF/container.xml", CONTAINER],
    ["OEBPS/content.opf", OPF],
    ["OEBPS/a.xhtml", "<html><body><p>Second <b>chapter</b>.</p></body></html>"],
    ["OEBPS/b.xhtml", "<html><body><h1>First</h1><script>var x=1;</script><p>Body &amp; tail.</p></body></html>"],
  ]);
  const tmp = await Deno.makeTempFile({ suffix: ".epub" });
  try {
    await Deno.writeFile(tmp, zip);
    const r = await runIngest(CFG, { kind: "path", value: tmp }, AbortSignal.timeout(15000));
    assertEquals(r.format, "epub");
    assertEquals(r.title, "Test Book");
    assert(r.text.indexOf("First") < r.text.indexOf("Second"), "spine order respected");
    assert(!r.text.includes("var x=1"), "script stripped");
    assert(r.text.includes("Body & tail."), "entities decoded");
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
});
