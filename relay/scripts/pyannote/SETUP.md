# Enabling pyannote diarization for the relay

Status: blocked on user action (Hugging Face account + token required).
The weights at `pyannote/speaker-diarization-community-1` are gated and
return HTTP 401 without an accepted-terms login, so none of the steps
below can be done by an agent. Run them in order.

## 1. Accept the model terms

While logged into Hugging Face, open
https://huggingface.co/pyannote/speaker-diarization-community-1
and accept the user conditions (contact-info share + CC-BY-4.0 pipeline).

## 2. Create an access token

Open https://hf.co/settings/tokens and create a token with read access.
Copy it; it looks like `hf_...`.

## 3. Log in and export the token

```sh
huggingface-cli login
export HF_TOKEN="hf_paste_your_token_here"
```

`huggingface-cli` ships with `huggingface_hub` (a `pyannote.audio`
dependency) and is already on PATH here. `diarize.py` reads `HF_TOKEN`.

## 4. Install the pinned dependencies

```sh
cd /Users/amin/development/muse-code-gui
python3 -m venv relay/scripts/pyannote/.venv
relay/scripts/pyannote/.venv/bin/python -m pip install -r relay/scripts/pyannote/requirements.txt
```

Prerequisite `ffmpeg` is already installed (`/opt/homebrew/bin/ffmpeg`;
needed by the `torchcodec` audio decoder per
https://github.com/pyannote/pyannote-audio).

## 5. Smoke-test on the sample clip

```sh
ffmpeg -y -v error -i /Users/amin/voice-samples/voice-sample.m4a -ar 16000 -ac 1 -c:a pcm_s16le /tmp/mcu-diarize-smoke.wav
HF_TOKEN="$HF_TOKEN" relay/scripts/pyannote/.venv/bin/python relay/scripts/pyannote/diarize.py /tmp/mcu-diarize-smoke.wav
```

First run downloads the gated weights (requires steps 1-3). Success is a
single JSON array on stdout, e.g.
`[{"start": 0.2, "end": 1.5, "speaker": "SPEAKER_00"}, ...]`.
Any failure prints `diarize.py: error: ...` on stderr with nonzero exit.

## 6. Wire the relay to the helper

```sh
chmod +x /Users/amin/development/muse-code-gui/relay/scripts/pyannote/diarize.py
export DIARIZE_HELPER="/Users/amin/development/muse-code-gui/relay/scripts/pyannote/diarize.py"
```

`DIARIZE_HELPER` must be executable and take the wav path as its only
argument (the relay invokes `DIARIZE_HELPER <wav>` and parses stdout as
JSON). If you used the venv above, either keep the `#!/usr/bin/env python3`
shebang working by installing the requirements into that `python3` too, or
point `DIARIZE_HELPER` at a wrapper that execs the venv interpreter.

## References

- Model card / usage: https://huggingface.co/pyannote/speaker-diarization-community-1
- Install / quickstart: https://github.com/pyannote/pyannote-audio
- Pins: `pyannote.audio==4.0.7`, `torch==2.14.0` (PyPI latest, 2026-09-13)
