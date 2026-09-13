import { assert, assertEquals } from "@std/assert";

const PORT = 18923;
const TOKEN = "test-token-do-not-use";
const BASE = `http://127.0.0.1:${PORT}`;

async function startRelay(): Promise<Deno.ChildProcess> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-run", "--allow-read", "--allow-write", "--allow-env", "src/server.ts"],
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...Deno.env.toObject(), RELAY_PORT: String(PORT), RELAY_TOKEN: TOKEN },
    stdout: "null",
    stderr: "null",
  });
  const child = cmd.spawn();
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (res.ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGTERM");
  throw new Error("relay did not start");
}

async function collectSse(res: Response): Promise<unknown[]> {
  const events: unknown[] = [];
  const text = await res.text();
  for (const frame of text.split("\n\n")) {
    for (const line of frame.split("\n")) {
      const t = line.trim();
      if (t.startsWith("data:")) events.push(JSON.parse(t.slice(5).trim()));
    }
  }
  return events;
}

Deno.test("server: auth gate + health + ingest + exec echo + mcp", async () => {
  const child = await startRelay();
  try {
    const anon = await fetch(`${BASE}/api/health`);
    assertEquals(anon.status, 401);
    // CORS: preflight passes without auth; real responses carry the origin header.
    const pre = await fetch(`${BASE}/api/exec`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://tauri.localhost",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    });
    assertEquals(pre.status, 204);
    assertEquals(pre.headers.get("Access-Control-Allow-Origin"), "*");
    assert(
      (pre.headers.get("Access-Control-Allow-Headers") ?? "").includes("Authorization"),
    );
    const healthRes = await fetch(`${BASE}/api/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assertEquals(healthRes.headers.get("Access-Control-Allow-Origin"), "*");
    const health = await (await fetch(`${BASE}/api/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json();
    assertEquals(health.ok, true);
    assert(typeof health.museBin === "string" && health.museBin !== "");

    const ing = await (await fetch(`${BASE}/api/ingest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ source: { kind: "text", value: "abc" } }),
    })).json();
    assertEquals(ing.text, "abc");

    // voice_exec validation rejects a missing audio source without spending.
    const badVoice = await fetch(`${BASE}/api/voice_exec`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(badVoice.status, 400);

    const execRes = await fetch(`${BASE}/api/exec`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "say hi", provider: "echo" }),
    });
    assertEquals(execRes.status, 200);
    const events = await collectSse(execRes);
    const done = events.find((e) => (e as { type: string }).type === "done") as { text: string; terminal: string };
    assert(done, `no done event in ${JSON.stringify(events).slice(0, 500)}`);
    assertEquals(done.terminal, "completed");
    assert(done.text.includes("echo: say hi"), done.text);

    const mcp = await (await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })).json();
    const names = (mcp.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    assertEquals(names, ["ingest_document", "muse_exec", "rss_episodes", "transcribe_audio", "voice_exec"]);

    // voice_exec validates its audio source before spending anything.
    const badVoiceMcp = await (await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "voice_exec", arguments: {} } }),
    })).json();
    assert(badVoiceMcp.error !== undefined, "voice_exec without audio must error");
  } finally {
    child.kill("SIGTERM");
    await child.status;
  }
});
