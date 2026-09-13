// museexec CLI surface: help, echo exec, health. Zero model spend
// (--provider echo); subscription billing is never touched here.

import { assert } from "@std/assert";

const RELAY = new URL("..", import.meta.url).pathname;
const DENO = Deno.execPath();
const PERMS = ["run", "--allow-run", "--allow-read", "--allow-write", "--allow-env", "--allow-net", "src/cli.ts"];

async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const done = await new Deno.Command(DENO, {
    args: [...PERMS, ...args],
    cwd: RELAY,
    env: Deno.env.toObject(),
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: done.code,
    out: new TextDecoder().decode(done.stdout),
    err: new TextDecoder().decode(done.stderr),
  };
}

Deno.test("cli: help and health", async () => {
  const help = await runCli(["--help"]);
  assert(help.code === 0 && help.out.includes("museexec"), `help failed: ${help.code} ${help.err}`);
  const health = await runCli(["health"]);
  assert(health.code === 0 && health.out.includes("billing"), `health failed: ${health.code} ${health.err}`);
});

Deno.test("cli: echo exec round trip", async () => {
  const r = await runCli(["--provider", "echo", "exec", "say hi"]);
  assert(r.code === 0, `exec failed: ${r.code} ${r.err}`);
  assert(r.out.includes("say hi"), `echo output missing prompt: ${r.out.slice(0, 200)}`);
});
