// MCP over stdio: newline-delimited JSON-RPC 2.0. One response line per
// request line; notifications produce no output. Logs go to stderr only.

import { loadConfig } from "./config.ts";
import { handleJsonRpc } from "./mcp.ts";

async function main(): Promise<void> {
  const cfg = loadConfig([]);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const stdout = Deno.stdout;
  for await (const chunk of Deno.stdin.readable) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line === "") continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        await stdout.write(
          encoder.encode(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n"),
        );
        continue;
      }
      const res = await handleJsonRpc(cfg, msg, AbortSignal.timeout(30 * 60_000));
      if (res !== null) {
        await stdout.write(encoder.encode(JSON.stringify(res) + "\n"));
      }
    }
  }
}

if (import.meta.main) {
  await main();
}
