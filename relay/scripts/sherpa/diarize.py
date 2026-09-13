#!/usr/bin/env python3
"""Offline multi-speaker diarizer (sherpa-onnx) for the muse-code-ui relay.

Contract (docs/TRANSCRIBE.md): argv[1] is a 16kHz mono wav path; print JSON
[{start, end, speaker}] on stdout. Invoked by the relay diarize stage with
just [wav]; anything else is ignored.

Follows the official k2-fsa example:
https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/offline-speaker-diarization.py
"""
import json
import os
import sys

import numpy as np
import sherpa_onnx
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
# <ROOT>/relay/scripts/sherpa -> <ROOT>/relay
RELAY_DIR = os.path.dirname(os.path.dirname(HERE))
MODELS_DIR = os.path.join(RELAY_DIR, "models", "sherpa")
SEG_MODEL = os.path.join(
    MODELS_DIR, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"
)
EMB_MODEL = os.path.join(MODELS_DIR, "nemo_en_titanet_small.onnx")


def resample_linear(audio: np.ndarray, sr: int, target_sr: int) -> np.ndarray:
    if sr == target_sr:
        return audio
    print(
        f"resampling {sr}Hz -> {target_sr}Hz (linear)",
        file=sys.stderr,
    )
    ratio = target_sr / sr
    new_len = int(round(len(audio) * ratio))
    old_idx = np.arange(len(audio))
    new_idx = np.arange(new_len) / ratio
    return np.interp(new_idx, old_idx, audio).astype(np.float32)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: diarize <16kHz-mono-wav> [num_speakers]", file=sys.stderr)
        return 2
    wav_path = sys.argv[1]
    if not os.path.isfile(wav_path):
        print(f"wav not found: {wav_path}", file=sys.stderr)
        return 2
    num_speakers = -1
    if len(sys.argv) > 2:
        try:
            num_speakers = int(sys.argv[2])
        except ValueError:
            pass
    env_ns = os.environ.get("DIARIZE_NUM_SPEAKERS", "").strip()
    if env_ns:
        try:
            num_speakers = int(env_ns)
        except ValueError:
            pass

    for p in (SEG_MODEL, EMB_MODEL):
        if not os.path.isfile(p):
            print(f"model missing: {p}", file=sys.stderr)
            return 3

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=SEG_MODEL
            ),
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=EMB_MODEL),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=num_speakers, threshold=0.5
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        print("invalid sherpa-onnx diarization config", file=sys.stderr)
        return 3
    sd = sherpa_onnx.OfflineSpeakerDiarization(config)

    audio, sr = sf.read(wav_path, dtype="float32", always_2d=True)
    audio = np.ascontiguousarray(audio[:, 0], dtype=np.float32)
    audio = resample_linear(audio, sr, sd.sample_rate)

    segments = sd.process(audio).sort_by_start_time()
    turns = [
        {"start": round(float(s.start), 3), "end": round(float(s.end), 3),
         "speaker": f"SPEAKER_{int(s.speaker):02d}"}
        for s in segments
        if float(s.end) > float(s.start)
    ]
    print(json.dumps(turns))
    return 0


if __name__ == "__main__":
    sys.exit(main())
