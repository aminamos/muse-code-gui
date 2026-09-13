import { assert, assertEquals } from "@std/assert";
import {
  buildExecArgs,
  stderrLineToUiEvent,
  wireLineToUiEvents,
} from "../src/muse.ts";
import {
  assignSpeakers,
  formatTimestamp,
  parseRssEpisodes,
  whisperJsonToSegments,
} from "../src/transcribe.ts";

const FIXTURE = new URL("../../testdata/exec-stream.jsonl", import.meta.url);

Deno.test("fixture: 34 lines parse to 1 delta + terminal completed", async () => {
  const lines = (await Deno.readTextFile(FIXTURE)).split("\n").filter((l) => l.trim() !== "");
  assertEquals(lines.length, 34);
  let deltas = "";
  let done: { text: string; terminal: string } | null = null;
  let errors = 0;
  lines.forEach((line, i) => {
    for (const e of wireLineToUiEvents(line, i + 1)) {
      if (e.type === "delta") deltas += e.text;
      else if (e.type === "done") done = { text: e.text, terminal: e.terminal };
      else if (e.type === "error") errors++;
    }
  });
  assertEquals(deltas, "echo: say hi");
  assertEquals(errors, 0);
  assert(done !== null);
  assertEquals((done as { terminal: string }).terminal, "completed");
});

Deno.test("wireLine: malformed lines become errors, parsing continues", () => {
  const [e1] = wireLineToUiEvents("not json", 7);
  assertEquals(e1, { type: "error", message: "line 7: unparseable JSON" });
  const [e2] = wireLineToUiEvents("{}", 3);
  assertEquals(e2, { type: "error", message: "line 3: missing payload_type" });
  const [e3] = wireLineToUiEvents('{"payload_type":"run.output.delta","payload":{"text":"x"}}', 1);
  assertEquals(e3, { type: "delta", text: "x" });
});

Deno.test("wireLine: lifecycle lines become info logs", () => {
  const [e] = wireLineToUiEvents('{"payload_type":"run.lifecycle.started","payload":{}}', 1);
  assertEquals(e, { type: "log", stream: "info", text: "run started" });
});

Deno.test("stderrLine: only muse diagnostics pass through", () => {
  assertEquals(stderrLineToUiEvent("muse: hello"), { type: "log", stream: "stderr", text: "muse: hello" });
  assertEquals(stderrLineToUiEvent("random noise"), null);
});

Deno.test("buildExecArgs: prompt last, flags before", () => {
  const args = buildExecArgs({ prompt: "hi", provider: "echo", yolo: true });
  assertEquals(args.slice(0, 2), ["exec", "--json"]);
  assert(args.includes("--user-input-auto-resolve"));
  assert(args.includes("echo"));
  assert(args.includes("--yolo"));
  assertEquals(args[args.length - 1], "hi");
});

Deno.test("whisperJsonToSegments: filters empties, joins text", () => {
  const { segments, language, text } = whisperJsonToSegments({
    language: "en",
    text: " Hello world ",
    segments: [
      { start: 0, end: 1.5, text: " Hello " },
      { start: 1.5, end: 3, text: "world" },
      { start: 3, end: 2, text: "bad range" },
      { start: 3, end: 4, text: "   " },
    ],
  });
  assertEquals(segments.length, 2);
  assertEquals(language, "en");
  assertEquals(text, "Hello world");
});

Deno.test("assignSpeakers: max-overlap wins, fallback SPEAKER_00", () => {
  const segs = [{ start: 0, end: 10, text: "a" }, { start: 20, end: 30, text: "b" }];
  assertEquals(assignSpeakers(segs, null).map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_00"]);
  const turns = [
    { start: 0, end: 6, speaker: "SPEAKER_00" },
    { start: 6, end: 12, speaker: "SPEAKER_01" },
  ];
  assertEquals(assignSpeakers(segs, turns).map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_00"]);
  const turns2 = [
    { start: 0, end: 4, speaker: "SPEAKER_00" },
    { start: 4, end: 12, speaker: "SPEAKER_01" },
  ];
  assertEquals(assignSpeakers(segs, turns2)[0].speaker, "SPEAKER_01");
});

Deno.test("parseRssEpisodes: enclosures + cdata titles", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Ep 1 & more]]></title><enclosure url="https://x/y.mp3" type="audio/mpeg"/></item>
    <item><title>No audio here</title></item>
    <item><title>Ep 2</title><enclosure url='https://x/z.m4a'/></item>
  </channel></rss>`;
  const eps = parseRssEpisodes(xml);
  assertEquals(eps.length, 2);
  assertEquals(eps[0], { index: 0, title: "Ep 1 & more", audioUrl: "https://x/y.mp3" });
  assertEquals(eps[1].audioUrl, "https://x/z.m4a");
});

Deno.test("formatTimestamp: mm:ss.mmm", () => {
  assertEquals(formatTimestamp(0), "00:00.000");
  assertEquals(formatTimestamp(65.5), "01:05.500");
});
