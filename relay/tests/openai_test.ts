import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildChatCompletionBody,
  buildChatPrompt,
  extractTextContent,
  formatChatChunkFrame,
  formatChatDoneFrame,
  openAiError,
} from "../src/openai.ts";

// ---------------------------------------------------------------------------
// Unit: prompt building + chunk framing (pure functions, no spend)
// ---------------------------------------------------------------------------

Deno.test("openai: buildChatPrompt joins system parts + last user", () => {
  const r = buildChatPrompt([
    { role: "system", content: "Be brief." },
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "system", content: "No markdown." },
    { role: "user", content: "second question" },
  ]);
  assertEquals(r, { ok: true, prompt: "Be brief.\n\nNo markdown.\n\nsecond question" });
});

Deno.test("openai: buildChatPrompt bare user message", () => {
  assertEquals(buildChatPrompt([{ role: "user", content: "say hi" }]), {
    ok: true,
    prompt: "say hi",
  });
});

Deno.test("openai: buildChatPrompt rejects empty/unsupported", () => {
  assertEquals(buildChatPrompt([]).ok, false);
  assertEquals(buildChatPrompt("nope").ok, false);
  assertEquals(buildChatPrompt([{ role: "system", content: "only system" }]).ok, false);
  assertEquals(buildChatPrompt([{ role: "user", content: "  " }]).ok, false);
  const tool = buildChatPrompt([{ role: "tool", content: "x" }]);
  assertEquals(tool.ok, false);
  if (!tool.ok) assertStringIncludes(tool.message, "unsupported role");
  const img = buildChatPrompt([
    { role: "user", content: [{ type: "image_url", image_url: "http://x/y.png" }] },
  ]);
  assertEquals(img.ok, false);
});

Deno.test("openai: buildChatPrompt accepts text-part content arrays", () => {
  const r = buildChatPrompt([
    { role: "user", content: [{ type: "text", text: "hel" }, { type: "text", text: "lo" }] },
  ]);
  assertEquals(r, { ok: true, prompt: "hello" });
});

Deno.test("openai: extractTextContent shapes", () => {
  assertEquals(extractTextContent("abc"), "abc");
  assertEquals(extractTextContent([{ type: "text", text: "a" }]), "a");
  assertEquals(extractTextContent([{ type: "image_url", image_url: "u" }]), null);
  assertEquals(extractTextContent(42), null);
  assertEquals(extractTextContent(null), null);
});

Deno.test("openai: chunk framing + completion body", () => {
  const frame = formatChatChunkFrame({
    id: "chatcmpl-1",
    created: 123,
    model: "muse-code",
    content: "hi",
    finishReason: null,
  });
  assert(frame.startsWith("data: ") && frame.endsWith("\n\n"), frame);
  const chunk = JSON.parse(frame.slice(6).trim());
  assertEquals(chunk.object, "chat.completion.chunk");
  assertEquals(chunk.choices[0].delta, { content: "hi" });
  assertEquals(chunk.choices[0].finish_reason, null);
  assertEquals(formatChatDoneFrame(), "data: [DONE]\n\n");

  const body = buildChatCompletionBody({ id: "chatcmpl-1", created: 123, model: "muse-code", content: "hi" });
  assertEquals(body.object, "chat.completion");
  assertEquals(
    (body.choices as Array<{ message: unknown }>)[0].message,
    { role: "assistant", content: "hi" },
  );
  assert(!("usage" in body), "usage must be omitted");

  assertEquals(openAiError("bad"), { error: { message: "bad", type: "invalid_request_error" } });
});

// ---------------------------------------------------------------------------
// Live: spawned relay (max 2 tiny turns total — subscription spend)
// ---------------------------------------------------------------------------

const PORT = 18924;
const TOKEN = "test-token-openai-do-not-use";
const BASE = `http://127.0.0.1:${PORT}`;
const FETCH_TIMEOUT = 180_000; // ≤180s per request

async function startRelay(): Promise<Deno.ChildProcess> {
  const env: Record<string, string> = { ...Deno.env.toObject(), RELAY_PORT: String(PORT), RELAY_TOKEN: TOKEN };
  delete env.META_API_KEY; // force subscription billing for the test server
  delete env.MUSE_API_TOKEN;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-run", "--allow-read", "--allow-write", "--allow-env", "src/server.ts"],
    cwd: new URL("..", import.meta.url).pathname,
    env,
    stdout: "null",
    stderr: "null",
  });
  const child = cmd.spawn();
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        await res.body?.cancel();
        return child;
      }
      await res.body?.cancel();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGTERM");
  throw new Error("relay did not start");
}

Deno.test("openai: models + auth gate + billing health (no spend)", async () => {
  const child = await startRelay();
  try {
    const anon = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    assertEquals(anon.status, 401);
    await anon.body?.cancel();

    const res = await fetch(`${BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.object, "list");
    const ids = (body.data as Array<{ id: string }>).map((m) => m.id);
    assert(ids.includes("muse-code"), JSON.stringify(body));

    const anonChat = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    assertEquals(anonChat.status, 401);
    await anonChat.body?.cancel();

    const bad = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    assertEquals(bad.status, 400);
    const badBody = await bad.json();
    assertEquals(typeof badBody.error.message, "string");

    const health = await (await fetch(`${BASE}/api/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })).json();
    assertEquals(health.billing, "subscription");
  } finally {
    child.kill("SIGTERM");
    await child.status;
  }
});

Deno.test("openai: one tiny non-stream turn (spend 1/2)", async () => {
  const child = await startRelay();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "say hi" }] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.object, "chat.completion");
    const content = body.choices[0].message.content as string;
    assert(typeof content === "string" && content.trim() !== "", JSON.stringify(body).slice(0, 500));
    assert(!("usage" in body), "usage must be omitted");
  } finally {
    child.kill("SIGTERM");
    await child.status;
  }
});

Deno.test("openai: one tiny stream turn via user session (spend 2/2)", async () => {
  const child = await startRelay();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "say yo" }],
        stream: true,
        user: "openai-test-user",
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    assertEquals(res.status, 200);
    const text = await res.text();
    assertStringIncludes(text, "data: [DONE]");
    let sawContent = false;
    for (const frame of text.split("\n\n")) {
      for (const line of frame.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:") || t === "data: [DONE]") continue;
        const chunk = JSON.parse(t.slice(5).trim());
        const content = chunk.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content !== "") sawContent = true;
      }
    }
    assert(sawContent, `no delta content in ${text.slice(0, 500)}`);
  } finally {
    child.kill("SIGTERM");
    await child.status;
  }
});
