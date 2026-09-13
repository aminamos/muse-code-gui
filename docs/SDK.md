# SDK engine spike (`@muse-code/sdk` 0.1.1, MSP)

The relay drives `muse` two ways. Engine selection lives in
`runMuseExec` (`relay/src/muse.ts`):

- Default: SDK first (`muse serve` via `MuseClient`), `muse exec`
  subprocess as fallback. A fallback emits an info log line; consumers
  may see two `started` events (SDK runId, then fallback runId).
- `MUSE_GUI_ENGINE=exec` forces the subprocess (escape hatch).

## What the SDK replaced

- `relay/src/muse-sdk.ts`: one-shot turns with the same `UiEvent`
  output as the exec path. Terminal/exit mapping, delta streaming with
  a settled-items reconcile pass, stderr forwarding, abort racing.
- `relay/src/sessions.ts`: stateful `SdkSessionManager` (shared host,
  in-memory registry). Wired into MCP `muse_exec`: a `sessionId` arg
  continues a managed conversation; without it, one-shot semantics.
  HTTP `/api/exec` stays one-shot (its `sessionId` goes to the exec
  fallback's `--session-id`, not the manager).
- `relay/tests/msp-conformance_test.ts`: fixture vs official
  `muse schema` export. Finding: `muse exec --json` emits a dotted
  trace vocabulary (`run.output.delta`, `task.lifecycle.*`) while MSP
  declares slash-form RPC names — 0/14 overlap, pinned as documented
  gaps with a freshness assertion. This is the strongest argument for
  the SDK path: it speaks the declared protocol.

## Mapping notes and spike limits

- Approvals auto-pick the first server-offered choice (parity with
  exec auto-resolve is behavioral; choice ordering unverified).
- Exec-only options throw inside the adapter so the dispatcher falls
  back: `provider: "echo"`, `yolo`, `maxModelSteps`, one-shot
  `sessionId`. Invalid `approvalMode`/`reasoningEffort` strings fail
  server-side.
- `sessions.ts` abort stops the event stream but does not cancel the
  server-side turn; `close()` drops the local handle only.
- Turn-item mapping is duplicated between `muse-sdk.ts` and
  `sessions.ts` (parallel authorship); unify behind one mapper next.
- Spend so far: 3 tiny turns in child tests + 3 in relay suite runs.

## Verify

`deno task check && deno task test` (includes live SDK turns).
Force the legacy path: `MUSE_GUI_ENGINE=exec deno task test`.
