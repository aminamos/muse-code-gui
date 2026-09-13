// ACP v1 framing over the real acp-stdio server. Exec turns use the
// `echo` provider (MUSE_ACP_PROVIDER) — zero model spend.

import { assert, assertEquals } from "@std/assert";

const RELAY = new URL("..", import.meta.url).pathname;
const DENO = Deno.execPath();

interface Pending {
  resolve: (line: string) => void;
}

async function startAcp(env: Record<string, string>): Promise<{
  write: (obj: unknown) => Promise<void>;
  read: () => Promise<string>;
  stop: () => void;
}> {
  const child = new Deno.Command(DENO, {
    args: ["run", "--allow-run", "--allow-read", "--allow-write", "--allow-env", "--allow-net", "src/acp-stdio.ts"],
    cwd: RELAY,
    env: { ...Deno.env.toObject(), ...env },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const writer = child.stdin.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const queue: string[] = [];
  const waiters: Pending[] = [];
  let buffer = "";
  let done = false;
  (async () => {
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line === "") continue;
        const w = waiters.shift();
        if (w) w.resolve(line);
        else queue.push(line);
      }
    }
    done = true;
  })();
  const read = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const next = queue.shift();
      if (next !== undefined) {
        resolve(next);
        return;
      }
      const timer = setTimeout(() => reject(new Error("acp read timeout (10s)") + (done ? " [stdout closed]" : "")), 10_000);
      waiters.push({
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });
  return {
    write: async (obj) => {
      await writer.write(encoder.encode(JSON.stringify(obj) + "\n"));
    },
    read,
    stop: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    },
  };
}

async function readUntilResponse(
  read: () => Promise<string>,
  id: number,
): Promise<{ notifications: unknown[]; response: Record<string, unknown> }> {
  const notifications: unknown[] = [];
  for (;;) {
    const line = await read();
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (msg.id === id) return { notifications, response: msg };
    notifications.push(msg);
  }
}

Deno.test("acp: initialize/new/prompt round trip (echo provider)", async () => {
  const acp = await startAcp({ MUSE_ACP_PROVIDER: "echo" });
  try {
    await acp.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const init = JSON.parse(await acp.read()) as Record<string, unknown>;
    assertEquals(init.id, 1);
    const initResult = init.result as Record<string, unknown>;
    assertEquals(initResult.protocolVersion, 1);
    assert(typeof initResult.agentCapabilities === "object");

    await acp.write({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: RELAY, mcpServers: [] } });
    const created = JSON.parse(await acp.read()) as Record<string, unknown>;
    const sessionId = (created.result as Record<string, unknown>).sessionId;
    assert(typeof sessionId === "string" && sessionId !== "");

    await acp.write({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "say hi" }] },
    });
    const { notifications, response } = await readUntilResponse(acp.read, 3);
    const chunks = notifications.filter(
      (n) =>
        (n as Record<string, unknown>).method === "session/update" &&
        ((n as Record<string, unknown>).params as Record<string, unknown>).sessionId === sessionId,
    );
    assert(chunks.length > 0, "expected at least one agent_message_chunk");
    const first = ((chunks[0] as Record<string, unknown>).params as Record<string, unknown>).update as Record<string, unknown>;
    assertEquals(first.sessionUpdate, "agent_message_chunk");
    assertEquals((response.result as Record<string, unknown>).stopReason, "end_turn");
  } finally {
    acp.stop();
  }
});

Deno.test("acp: honest errors for unknown session, non-text blocks, unknown methods", async () => {
  const acp = await startAcp({ MUSE_ACP_PROVIDER: "echo" });
  try {
    await acp.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await acp.read();

    await acp.write({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "nope", prompt: [{ type: "text", text: "hi" }] },
    });
    const badSession = JSON.parse(await acp.read()) as Record<string, unknown>;
    assert(badSession.error !== undefined, "unknown session must error");

    await acp.write({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: RELAY, mcpServers: [] } });
    const created = JSON.parse(await acp.read()) as Record<string, unknown>;
    const sessionId = (created.result as Record<string, unknown>).sessionId as string;

    await acp.write({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "image", data: "eA==", mimeType: "image/png" }] },
    });
    const badBlock = JSON.parse(await acp.read()) as Record<string, unknown>;
    assert(badBlock.error !== undefined, "image blocks must error (audio:false/image:false)");

    await acp.write({ jsonrpc: "2.0", id: 5, method: "session/load", params: {} });
    const noLoad = JSON.parse(await acp.read()) as Record<string, unknown>;
    assertEquals((noLoad.error as Record<string, unknown>).code, -32601);
  } finally {
    acp.stop();
  }
});
