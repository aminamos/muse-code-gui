import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  auditBinaries,
  candidateNames,
  deriveFfprobe,
  expandBinPath,
  formatBinaryAudit,
  installHint,
  isExplicitPath,
  missingBinaryError,
  splitPathEnv,
  splitWorkspaceRoots,
} from "../src/config.ts";
import type { RelayConfig } from "../src/config.ts";
import { buildExecArgs, buildExecCommand } from "../src/muse.ts";
import {
  buildDiarizerCommands,
  isSpawnNotFound,
} from "../src/transcribe.ts";
import { basenameCrossPlatform } from "../src/ingest.ts";
import { workspaceAllowed } from "../src/server.ts";

// ---------------------------------------------------------------------------
// WSL launcher arg building (pure, zero spend)
// ---------------------------------------------------------------------------

Deno.test("portability: buildExecCommand without launcher is direct", () => {
  const execArgs = buildExecArgs({ prompt: "hi" });
  assertEquals(buildExecCommand("/usr/local/bin/muse", execArgs, null), {
    bin: "/usr/local/bin/muse",
    args: execArgs,
  });
  assertEquals(buildExecCommand("muse", execArgs, undefined), { bin: "muse", args: execArgs });
  assertEquals(buildExecCommand("muse", execArgs, ""), { bin: "muse", args: execArgs });
  assertEquals(buildExecCommand("muse", execArgs, "   "), { bin: "muse", args: execArgs });
});

Deno.test("portability: buildExecCommand with MUSE_LAUNCHER wraps [launcher, museBin, ...args]", () => {
  const execArgs = buildExecArgs({ prompt: "hi", workspace: "/home/user/proj" });
  const wrapped = buildExecCommand("muse", execArgs, "wsl");
  assertEquals(wrapped.bin, "wsl");
  assertEquals(wrapped.args[0], "muse");
  assertEquals(wrapped.args.slice(1), execArgs);
  // Workspace passthrough is verbatim (WSL paths are user responsibility).
  const wsIdx = wrapped.args.indexOf("--workspace");
  assert(wsIdx !== -1);
  assertEquals(wrapped.args[wsIdx + 1], "/home/user/proj");
});

Deno.test("portability: buildExecCommand trims launcher value", () => {
  const wrapped = buildExecCommand("muse", ["exec", "hi"], "  wsl  ");
  assertEquals(wrapped, { bin: "wsl", args: ["muse", "exec", "hi"] });
});

// ---------------------------------------------------------------------------
// Binary-missing error paths (pure, zero spend)
// ---------------------------------------------------------------------------

Deno.test("portability: whisper missing error names install step per OS", () => {
  assertStringIncludes(missingBinaryError("whisper", "darwin").message, "WHISPER_BIN");
  assertStringIncludes(missingBinaryError("whisper", "darwin").message, "brew install");
  assertStringIncludes(missingBinaryError("whisper", "linux").message, "pip install openai-whisper");
  assertStringIncludes(missingBinaryError("whisper", "windows").message, "pip install openai-whisper");
  assertStringIncludes(missingBinaryError("whisper", "windows").message, "WHISPER_BIN");
});

Deno.test("portability: ffmpeg missing error names install step per OS", () => {
  for (const os of ["darwin", "linux", "windows"] as const) {
    const msg = missingBinaryError("ffmpeg", os).message;
    assertStringIncludes(msg, "ffmpeg binary not found");
    assertStringIncludes(msg, "FFMPEG_BIN");
  }
  assertStringIncludes(missingBinaryError("ffmpeg", "darwin").message, "brew install ffmpeg");
  assertStringIncludes(missingBinaryError("ffmpeg", "linux").message, "apt install ffmpeg");
  assertStringIncludes(missingBinaryError("ffmpeg", "windows").message, "winget install");
  assertStringIncludes(missingBinaryError("ffprobe", "windows").message, "FFPROBE_BIN");
});

Deno.test("portability: muse/pdftotext/unzip hints name env overrides", () => {
  assertStringIncludes(missingBinaryError("muse", "darwin").message, "MUSE_BIN");
  assertStringIncludes(missingBinaryError("muse", "windows").message, "MUSE_LAUNCHER");
  assertStringIncludes(installHint("pdftotext", "darwin"), "PDFTOTEXT_BIN");
  assertStringIncludes(installHint("unzip", "windows"), "PATH");
});

Deno.test("portability: isSpawnNotFound detects cross-OS missing-binary throws", () => {
  assert(isSpawnNotFound(new Deno.errors.NotFound("not found")));
  assert(isSpawnNotFound(new Error("No such file or directory (os error 2)")));
  assert(isSpawnNotFound(new Error("spawn 'ffmpeg' failed: ENOENT")));
  assert(isSpawnNotFound(new Error("The system cannot find the file specified. (os error 2)")));
  assert(!isSpawnNotFound(new Error("ffmpeg decode failed: invalid data")));
  assert(!isSpawnNotFound(new Error("permission denied")));
});

Deno.test("portability: auditBinaries reports found/missing per binary", () => {
  const cfg = {
    museBin: "muse",
    museLauncher: "wsl",
    whisperBin: null,
    ffmpegBin: "/usr/bin/ffmpeg",
    ffprobeBin: null,
    pdftotextBin: null,
    unzipBin: "/usr/bin/unzip",
    diarizeHelper: null,
  } as RelayConfig;
  const audit = auditBinaries(cfg);
  assertEquals(audit.muse, { bin: "muse", found: true });
  assertEquals(audit.whisper, { bin: null, found: false });
  assertEquals(audit.ffmpeg.found, true);
  assertEquals(audit.ffprobe.found, false);
  assertEquals(audit.unzip.found, true);
  assertEquals(audit.diarizer.found, false);
  const formatted = formatBinaryAudit(cfg);
  assertStringIncludes(formatted, "whisper=missing");
  assertStringIncludes(formatted, "launcher=wsl");
});

// ---------------------------------------------------------------------------
// Diarizer invocation selection (pure, zero spend)
// ---------------------------------------------------------------------------

Deno.test("portability: buildDiarizerCommands tries direct then python3 then python", () => {
  const cmds = buildDiarizerCommands("/relay/scripts/sherpa/diarize", "/tmp/audio.wav");
  assertEquals(cmds.length, 3);
  assertEquals(cmds[0], { bin: "/relay/scripts/sherpa/diarize", args: ["/tmp/audio.wav"] });
  assertEquals(cmds[1], {
    bin: "python3",
    args: ["/relay/scripts/sherpa/diarize", "/tmp/audio.wav"],
  });
  assertEquals(cmds[2], {
    bin: "python",
    args: ["/relay/scripts/sherpa/diarize", "/tmp/audio.wav"],
  });
});

Deno.test("portability: buildDiarizerCommands passes .py helpers through interpreters too", () => {
  const cmds = buildDiarizerCommands("C:\\relay\\scripts\\sherpa\\diarize.py", "C:\\tmp\\audio.wav");
  assertEquals(cmds[0].bin, "C:\\relay\\scripts\\sherpa\\diarize.py");
  assertEquals(cmds[1], {
    bin: "python3",
    args: ["C:\\relay\\scripts\\sherpa\\diarize.py", "C:\\tmp\\audio.wav"],
  });
  assertEquals(cmds[2].bin, "python");
});

// ---------------------------------------------------------------------------
// Path handling across macOS/Linux/Windows (pure, zero spend)
// ---------------------------------------------------------------------------

Deno.test("portability: deriveFfprobe handles bare names, paths, and .exe", () => {
  assertEquals(deriveFfprobe("ffmpeg"), "ffprobe");
  assertEquals(deriveFfprobe("/usr/bin/ffmpeg"), "/usr/bin/ffprobe");
  assertEquals(deriveFfprobe("C:\\ffmpeg\\bin\\ffmpeg.exe"), "C:\\ffmpeg\\bin\\ffprobe.exe");
  assertEquals(deriveFfprobe("/opt/ffmpeg/ffmpeg.EXE"), "/opt/ffmpeg/ffprobe.EXE");
});

Deno.test("portability: splitPathEnv uses ; on Windows and : elsewhere", () => {
  assertEquals(splitPathEnv("/a:/b", "darwin"), ["/a", "/b"]);
  assertEquals(splitPathEnv("/a:/b", "linux"), ["/a", "/b"]);
  assertEquals(splitPathEnv("C:\\bin;D:\\tools", "windows"), ["C:\\bin", "D:\\tools"]);
});

Deno.test("portability: candidateNames adds Windows suffixes only on Windows", () => {
  assertEquals(candidateNames("muse", "darwin"), ["muse"]);
  assertEquals(candidateNames("muse", "linux"), ["muse"]);
  assertEquals(candidateNames("muse", "windows"), ["muse", "muse.exe", "muse.cmd", "muse.bat"]);
  assertEquals(candidateNames("muse.exe", "windows"), ["muse.exe"]);
});

Deno.test("portability: isExplicitPath detects slashes, backslashes, drive letters", () => {
  assert(!isExplicitPath("muse"));
  assert(isExplicitPath("/usr/local/bin/muse"));
  assert(isExplicitPath("C:\\tools\\muse.exe"));
  assert(isExplicitPath("C:/tools/muse.exe"));
  assert(isExplicitPath("\\\\server\\share\\muse.exe"));
});

Deno.test("portability: expandBinPath expands %VAR% and ~/ ", () => {
  Deno.env.set("PORTABILITY_TEST_PROFILE", "C:\\Users\\tester");
  try {
    assertEquals(
      expandBinPath("%PORTABILITY_TEST_PROFILE%\\bin\\muse.exe"),
      "C:\\Users\\tester\\bin\\muse.exe",
    );
    assertEquals(expandBinPath("%PORTABILITY_TEST_MISSING%\\muse"), "%PORTABILITY_TEST_MISSING%\\muse");
  } finally {
    Deno.env.delete("PORTABILITY_TEST_PROFILE");
  }
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  if (home !== "") {
    assertEquals(expandBinPath("~/bin/muse"), `${home}/bin/muse`);
  }
});

Deno.test("portability: splitWorkspaceRoots keeps Windows drive letters intact", () => {
  assertEquals(splitWorkspaceRoots("/a:/b", "darwin"), ["/a", "/b"]);
  assertEquals(splitWorkspaceRoots("C:\\work;D:\\src", "windows"), ["C:\\work", "D:\\src"]);
  assertEquals(splitWorkspaceRoots("C:\\work", "windows"), ["C:\\work"]);
});

Deno.test("portability: basename handles POSIX and Windows separators", () => {
  assertEquals(basenameCrossPlatform("/tmp/docs/book.epub"), "book.epub");
  assertEquals(basenameCrossPlatform("C:\\tmp\\docs\\book.epub"), "book.epub");
  assertEquals(basenameCrossPlatform("C:/tmp/docs/report.pdf"), "report.pdf");
  assertEquals(basenameCrossPlatform("C:\\tmp\\a.pdf"), "a.pdf");
});

Deno.test("portability: workspaceAllowed is backslash/case tolerant on Windows", () => {
  const cfg = { workspaceRoots: ["C:\\work\\proj"] } as RelayConfig;
  assert(workspaceAllowed(cfg, "C:\\work\\proj\\sub\\file.txt", "windows"));
  assert(workspaceAllowed(cfg, "c:/WORK/proj/sub", "windows"));
  assert(workspaceAllowed(cfg, "C:\\work\\proj", "windows"));
  assert(!workspaceAllowed(cfg, "C:\\work\\other", "windows"));
  assert(!workspaceAllowed(cfg, "C:\\work\\proj-sibling\\x", "windows"));
});

Deno.test("portability: workspaceAllowed keeps POSIX behavior", () => {
  const cfg = { workspaceRoots: ["/work/proj"] } as RelayConfig;
  assert(workspaceAllowed(cfg, "/work/proj/a", "darwin"));
  assert(workspaceAllowed(cfg, "/work/proj", "darwin"));
  assert(!workspaceAllowed(cfg, "/work/other", "darwin"));
  assert(!workspaceAllowed(cfg, "/work/proj-sibling", "darwin"));
  const open = { workspaceRoots: null } as RelayConfig;
  assert(workspaceAllowed(open, "/anything", "darwin"));
});
