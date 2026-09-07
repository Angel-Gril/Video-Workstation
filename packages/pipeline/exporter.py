#!/usr/bin/env python3
"""Timeline export bridge. Receives a normalized JSON plan and invokes FFmpeg."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any


class ExportError(RuntimeError):
    pass


def build_filtergraph(plan: dict[str, Any]) -> str:
    """Builds a conservative single-video/audio export plan."""
    video_clips = [clip for clip in plan.get("video", []) if clip.get("path")]
    audio_clips = [clip for clip in plan.get("audio", []) if clip.get("path")]
    if not video_clips and not audio_clips:
        raise ExportError("Export plan has no usable clips")

    inputs: list[str] = []
    labels: list[str] = []
    for index, clip in enumerate(video_clips):
        inputs.extend(["-ss", str(clip["sourceStart"]), "-t", str(clip["duration"]), "-i", clip["path"]])
        labels.append(f"[{index}:v]")
    audio_start = len(video_clips)
    for offset, clip in enumerate(audio_clips):
        inputs.extend(["-ss", str(clip["sourceStart"]), "-t", str(clip["duration"]), "-i", clip["path"]])
        labels.append(f"[{audio_start + offset}:a]")

    if video_clips:
        graph = "".join(labels) + f"concat=n={len(video_clips)}:v=1:a=0[v]"
    else:
        graph = ""

    if audio_clips:
        audio_concat = "".join(f"[{audio_start + offset}:a]" for offset in range(len(audio_clips)))
        graph += f";{audio_concat}concat=n={len(audio_clips)}:v=0:a=1[a]"

    args = [ffmpeg_binary(), "-y", *inputs, "-filter_complex", graph, "-map", "[v]" if video_clips else "-map", "[a]" if audio_clips else "-map"]
    return " ".join(args)  # shell preview only; execution builds argv list separately


def ffmpeg_binary() -> str:
    import shutil

    binary = shutil.which("ffmpeg")
    if not binary:
        raise ExportError("FFmpeg was not found on PATH.")
    return binary


def export(plan_path: Path, output: Path) -> dict[str, Any]:
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    video_clips = [clip for clip in plan.get("video", []) if clip.get("path")]
    audio_clips = [clip for clip in plan.get("audio", []) if clip.get("path")]
    if not video_clips and not audio_clips:
        raise ExportError("Export plan has no usable clips")

    args = [ffmpeg_binary(), "-y"]
    for clip in video_clips:
        args.extend(["-ss", str(clip["sourceStart"]), "-t", str(clip["duration"]), "-i", clip["path"]])
    for clip in audio_clips:
        args.extend(["-ss", str(clip["sourceStart"]), "-t", str(clip["duration"]), "-i", clip["path"]])

    filters: list[str] = []
    map_args: list[str] = []
    if video_clips:
        labels = "".join(f"[{index}:v]" for index in range(len(video_clips)))
        filters.append(f"{labels}concat=n={len(video_clips)}:v=1:a=0[v]")
        map_args.extend(["-map", "[v]"])
    if audio_clips:
        labels = "".join(f"[{len(video_clips) + index}:a]" for index in range(len(audio_clips)))
        filters.append(f"{labels}concat=n={len(audio_clips)}:v=0:a=1[a]")
        map_args.extend(["-map", "[a]"])

    if filters:
        args.extend(["-filter_complex", ";".join(filters)])
    args.extend(map_args)
    args.extend(["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k"])
    args.append(str(output))
    output.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise ExportError(result.stderr.strip()[-2000:] or "Export failed")
    return {"output": str(output), "videoClips": len(video_clips), "audioClips": len(audio_clips)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(export(Path(args.plan).expanduser(), Path(args.output).expanduser()), ensure_ascii=False))
    except ExportError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
