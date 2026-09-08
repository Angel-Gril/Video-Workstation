#!/usr/bin/env python3
"""Media inspection and transcoding bridge for the workstation."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any


class PipelineError(RuntimeError):
    pass


def ffmpeg_binary() -> str:
    override = os.environ.get("FFMPEG_PATH")
    if override and Path(override).is_file():
        return override
    binary = shutil.which("ffmpeg")
    if not binary:
        raise PipelineError(
            "FFmpeg was not found on PATH. Install FFmpeg or set FFMPEG_PATH."
        )
    return binary


def ffprobe_binary() -> str:
    override = os.environ.get("FFPROBE_PATH")
    if override and Path(override).is_file():
        return override
    binary = shutil.which("ffprobe")
    if not binary:
        raise PipelineError(
            "ffprobe was not found on PATH. Install FFmpeg or set FFPROBE_PATH."
        )
    return binary


def run_json(args: list[str]) -> dict[str, Any]:
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise PipelineError(result.stderr.strip() or "Media probe failed")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise PipelineError(f"ffprobe returned invalid JSON: {error}") from error


def decimal(value: str | None) -> float | None:
    try:
        return None if value is None else float(value)
    except ValueError:
        return None


def media_kind(streams: list[dict[str, Any]], path: Path) -> str:
    suffixes = {
        ".mp3": "audio",
        ".wav": "audio",
        ".m4a": "audio",
        ".flac": "audio",
        ".srt": "caption",
        ".ass": "caption",
    }
    if path.suffix.lower() in suffixes:
        return suffixes[path.suffix.lower()]
    if any(stream.get("codec_type") == "video" for stream in streams):
        return "video"
    return "audio"


def probe(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise PipelineError(f"Media file does not exist: {path}")
    data = run_json([
        ffprobe_binary(),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ])
    streams = data.get("streams", [])
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    video_index = streams.index(video) if video else None
    audio_index = streams.index(audio) if audio else None
    duration = decimal(data.get("format", {}).get("duration"))
    if duration is None:
        duration = decimal(video.get("duration") if video else None)
    if duration is None:
        duration = decimal(audio.get("duration") if audio else None)
    return {
        "id": f"media-{path.stem}",
        "kind": media_kind(streams, path),
        "name": path.name,
        "path": path.resolve().as_posix(),
        "duration": duration or 0,
        "width": int(video["width"]) if video and "width" in video else None,
        "height": int(video["height"]) if video and "height" in video else None,
        "frameRate": frame_rate(video.get("avg_frame_rate")) if video else None,
        "audioChannels": int(audio["channels"]) if audio and "channels" in audio else None,
        "audioSampleRate": int(audio["sample_rate"]) if audio and "sample_rate" in audio else None,
        "codec": video.get("codec_name") if video else audio.get("codec_name") if audio else None,
        "videoStreamIndex": video_index,
        "audioStreamIndex": audio_index,
    }


def frame_rate(value: str | None) -> float | None:
    if not value or value == "0/0":
        return None
    numerator, separator, denominator = value.partition("/")
    try:
        if separator:
            return float(numerator) / float(denominator)
        return float(numerator)
    except (ValueError, ZeroDivisionError):
        return None


def transcode(source: Path, output: Path, preset: str) -> dict[str, Any]:
    if not source.exists():
        raise PipelineError(f"Source does not exist: {source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg_binary(),
        "-y",
        "-i",
        str(source),
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        str(output),
    ]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise PipelineError(result.stderr.strip()[-2000:] or "Transcode failed")
    return {"source": str(source), "output": str(output), "asset": probe(output)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["probe", "transcode"])
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    parser.add_argument("--preset", default="medium")
    args = parser.parse_args()

    try:
        input_path = Path(args.input).expanduser().resolve()
        if args.command == "probe":
            result: dict[str, Any] = probe(input_path)
        else:
            if not args.output:
                raise PipelineError("--output is required for transcode")
            result = transcode(input_path, Path(args.output).expanduser().resolve(), args.preset)
        print(json.dumps(result, ensure_ascii=False))
    except PipelineError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
