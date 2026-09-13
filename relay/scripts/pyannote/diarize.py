#!/usr/bin/env python3
"""Speaker-diarization helper for the muse-code-gui relay.

Contract (docs/TRANSCRIBE.md, relay/src/transcribe.ts diarize stage):
  argv[1] = path to a 16 kHz mono wav file
  stdout  = JSON array [{start: float, end: float, speaker: str}]
  stderr  = human-readable diagnostics; nonzero exit on any failure.

Pipeline usage follows the official model card
(https://huggingface.co/pyannote/speaker-diarization-community-1):
  Pipeline.from_pretrained(..., token=...) then output.speaker_diarization,
  which yields (turn, speaker) pairs with turn.start/turn.end in seconds.
Pipelines run on CPU by default (no .to() call), which is the macOS path.

Auth: Hugging Face access token via the HF_TOKEN environment variable.
All third-party imports are lazy so a missing install fails with a clear
message instead of a traceback.
"""

import json
import os
import sys

MODEL_ID = "pyannote/speaker-diarization-community-1"


def fail(message, code=1):
    print("diarize.py: error: {}".format(message), file=sys.stderr)
    return code


def main(argv):
    if len(argv) != 2:
        print("usage: diarize.py <16kHz-mono-wav>", file=sys.stderr)
        return 2
    wav_path = argv[1]
    if not os.path.isfile(wav_path):
        return fail("wav file not found: {}".format(wav_path))
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        return fail(
            "HF_TOKEN is not set. Accept the terms at "
            "https://huggingface.co/pyannote/speaker-diarization-community-1 "
            "then create a token at https://hf.co/settings/tokens "
            "and run: export HF_TOKEN=<token>"
        )
    try:
        from pyannote.audio import Pipeline
    except ImportError:
        return fail(
            "pyannote.audio is not installed. Run: python3 -m pip install "
            "-r relay/scripts/pyannote/requirements.txt "
            "(see relay/scripts/pyannote/SETUP.md)"
        )
    try:
        pipeline = Pipeline.from_pretrained(MODEL_ID, token=token)
    except Exception as exc:
        return fail("failed to load {}: {}".format(MODEL_ID, exc))
    try:
        output = pipeline(wav_path)
    except Exception as exc:
        return fail("diarization failed for {}: {}".format(wav_path, exc))
    diarization = getattr(output, "speaker_diarization", None)
    if diarization is None:
        return fail("pipeline output has no speaker_diarization attribute")
    turns = []
    for turn, speaker in diarization:
        start, end = float(turn.start), float(turn.end)
        if not end > start:
            continue
        turns.append({"start": start, "end": end, "speaker": str(speaker)})
    json.dump(turns, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
