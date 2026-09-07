#!/usr/bin/env python3
"""Local media service for the video workstation."""

from __future__ import annotations

import json
import math
import mimetypes
import re
import shutil
import os
import subprocess
import sys
import threading
import traceback
import uuid
import tempfile
import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from PIL import Image

from media_probe import PipelineError, ffprobe_binary, media_kind, probe


HOST = "127.0.0.1"
PORT = 7350
PROJECT_FILE = Path(".aiwork/current.aiwork.json")
WHISPER_MODEL_NAME = "base"
TTS_VOICE = os.environ.get("WORKSTATION_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
TTS_RATE = os.environ.get("WORKSTATION_TTS_RATE", "+0%")
TTS_OUTPUT_DIR = Path(os.environ.get("WORKSTATION_TTS_DIR", ".aiwork/tts")).resolve()
whisper_lock = threading.Lock()
whisper_model: Any | None = None
jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.Lock()
job_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pipeline-job")


def ffmpeg_binary() -> str:
    override = os.environ.get("FFMPEG_PATH")
    if override:
        return override
    binary = shutil.which("ffmpeg")
    if not binary:
        raise PipelineError("FFmpeg was not found on PATH.")
    return binary


def ffprobe_override() -> str | None:
    return os.environ.get("FFPROBE_PATH")


class BadRequestError(PipelineError):
    pass


@dataclass
class ApiRequest:
    body: dict[str, Any]
    query: dict[str, str]


def media_stream(path: Path, start: int, length: int) -> bytes:
    with path.open("rb") as file:
        file.seek(start)
        return file.read(length)


def scene_analysis(path: Path, threshold: float) -> dict[str, Any]:
    command = [
        ffmpeg_binary(),
        "-hide_banner",
        "-i",
        str(path),
        "-vf",
        f"select='gt(scene,{threshold:.3f})',showinfo",
        "-f",
        "null",
        "-",
    ]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    boundaries: list[dict[str, Any]] = []
    current = 0.0
    pattern = re.compile(r"lavfi\.showinfo\.pts_time:([0-9]+(?:\.[0-9]+)?)")
    for line in result.stderr.splitlines():
        match = pattern.search(line)
        if match:
            at = float(match.group(1))
            boundaries.append({"start": current, "end": at, "score": threshold})
            current = at
    asset = probe(path)
    if asset["duration"] > current:
        boundaries.append({"start": current, "end": asset["duration"], "score": 1 - threshold})

    normalized = []
    for index, item in enumerate(boundaries):
        start = max(0, item["start"])
        end = min(asset["duration"], item["end"])
        if end - start < 0.25:
            continue
        normalized.append({
            "id": f"scene-{index + 1}",
            "mediaId": asset["id"],
            "start": start,
            "end": end,
            "score": item["score"],
        })
    return {"asset": asset, "scenes": normalized}


def tts_synthesis(
    text: str,
    output: Path | None = None,
    voice: str | None = None,
    rate: str | None = None,
) -> dict[str, Any]:
    clean = text.strip()
    if not clean:
        raise PipelineError("TTS text is required")
    if not output:
        TTS_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        output = TTS_OUTPUT_DIR / f"narration-{uuid.uuid4().hex}.mp3"
    output.parent.mkdir(parents=True, exist_ok=True)
    clean_voice = (voice or TTS_VOICE).strip() or TTS_VOICE
    clean_rate = (rate or TTS_RATE).strip() or TTS_RATE
    if not re.fullmatch(r"[-+]\d{1,3}%", clean_rate):
        raise PipelineError("TTS rate must use a percent format such as +10%")
    command = [
        "edge-tts", "--voice", clean_voice, "--rate", clean_rate,
        "--text", clean, "--write-media", str(output)
    ]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        if "edge-tts" in detail and "not" in detail.lower():
            raise PipelineError("edge-tts was not found. Install it with: pip install edge-tts")
        raise PipelineError(detail[-2000:] or "TTS synthesis failed")
    if not output.exists() or output.stat().st_size == 0:
        raise PipelineError("TTS synthesis produced an empty file")
    result = probe(output)
    return {
        **result,
        "name": output.stem,
        "path": str(output.resolve()),
        "narration": clean,
        "voice": clean_voice,
        "rate": clean_rate,
    }


def narration_drafts(plan: dict[str, Any], max_chars: int = 90) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for clip in plan.get("audio", []):
        text = str(clip.get("narration", "") or "").strip()
        if not clip.get("narrationPending", False) or not text:
            continue
        entries.append({
            "clipId": clip.get("id"),
            "timelineStart": max(0.0, float(clip.get("timelineStart", 0))),
            "duration": max(0.05, float(clip.get("duration", 1))),
            "text": text[:max_chars],
            "voice": str(clip.get("narrationVoice", "") or plan.get("narrationVoice", "")),
            "rate": str(clip.get("narrationRate", "") or plan.get("narrationRate", "")),
        })
    entries.sort(key=lambda item: item["timelineStart"])
    return entries


def fcpxml_time(value: float, frame_rate: float) -> str:
    rate = max(1, int(frame_rate))
    return f"{max(0, round(value * rate))}/{rate}s"


def xml_escape(value: Any) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def create_fcpxml(plan: dict[str, Any], output: Path) -> Path:
    meta = plan.get("meta", {})
    rate = max(1, int(meta.get("frameRate", 30)))
    sections = ("video", "audio", "caption", "music")
    media_paths = {str(entry["path"]) for section in sections for entry in plan.get(section, [])}
    asset_ids = {path: f"asset-{index + 1}" for index, path in enumerate(sorted(media_paths))}
    asset_nodes: list[str] = []
    for path, asset_id in asset_ids.items():
        try:
            asset = probe(Path(path))
        except PipelineError:
            continue
        asset_nodes.append(
            f'<asset id="{asset_id}" name="{xml_escape(asset["name"])}" src="file:///{Path(path).as_posix()}" '
            f'start="0s" duration="{fcpxml_time(asset["duration"], asset.get("frameRate") or rate)}" '
            f'hasVideo="{0 if asset["kind"] == "audio" else 1}" hasAudio="{1 if asset.get("audioChannels") else 0}" />'
        )

    def asset_clip(entry: dict[str, Any]) -> str:
        asset_id = asset_ids.get(str(entry["path"]), "")
        return (
            f'<asset-clip ref="{asset_id}" name="{xml_escape(entry.get("text") or entry["id"])}" '
            f'offset="{fcpxml_time(entry["timelineStart"], rate)}" start="{fcpxml_time(entry["sourceStart"], rate)}" '
            f'duration="{fcpxml_time(entry["duration"], rate)}"><note>{xml_escape(entry.get("text") or "")}</note></asset-clip>'
        )

    duration = max(
        [0.0]
        + [
            float(entry["timelineStart"]) + float(entry["duration"])
            for section in sections
            for entry in plan.get(section, [])
        ]
    )
    spine = "".join(asset_clip(entry) for entry in plan.get("video", []))
    document = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<fcpxml version="1.10"><resources>{"".join(asset_nodes)}</resources>'
        f'<library><event name="AI Video Workstation"><project name="{xml_escape(meta.get("name", "Project"))}">'
        f'<sequence duration="{fcpxml_time(duration, rate)}"><spine>{spine}</spine></sequence>'
        '</project></event></library></fcpxml>'
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(document, encoding="utf-8")
    return output


def create_jianying_draft(plan: dict[str, Any], output: Path) -> Path:
    meta = plan.get("meta", {})
    rate = max(1, int(meta.get("frameRate", 30)))
    micro = 1_000_000
    tracks: list[dict[str, Any]] = [
        {"id": "track-video", "type": "video", "segments": []},
        {"id": "track-audio", "type": "audio", "segments": []},
        {"id": "track-caption", "type": "text", "segments": []},
    ]
    materials: list[dict[str, Any]] = []
    asset_ids: dict[str, str] = {}
    sections = {
        "video": "track-video",
        "audio": "track-audio",
        "music": "track-audio",
        "caption": "track-caption",
    }
    for section, track_id in sections.items():
        for index, entry in enumerate(plan.get(section, [])):
            path = str(entry["path"])
            if path not in asset_ids:
                asset_ids[path] = f"material-{len(asset_ids) + 1}"
                materials.append({"id": asset_ids[path], "path": path, "name": Path(path).name})
            source = round(float(entry["sourceStart"]) * micro)
            target = round(float(entry["timelineStart"]) * micro)
            duration = round(float(entry["duration"]) * micro)
            tracks[0 if track_id == "track-video" else 1 if track_id == "track-audio" else 2][
                "segments"
            ].append({
                "id": f"{track_id}-{index + 1}",
                "material_id": asset_ids[path],
                "target_timerange": {"start": target, "duration": duration},
                "source_timerange": {"start": source, "duration": duration},
                "text": entry.get("text") or None,
                "transition_in": entry.get("transitionIn") or "none",
                "transition_out": entry.get("transitionOut") or "none",
                "transition_duration": entry.get("transitionDuration") or 0.5,
                "volume": entry.get("volume", 1),
            })
    draft = {
        "format": "jianying-compatible-draft/1",
        "project": {
            "name": meta.get("name", "AI Video Workstation"),
            "width": meta.get("width", 1920),
            "height": meta.get("height", 1080),
            "fps": rate,
            "duration": round(max([0.0] + [entry["timelineStart"] + entry["duration"] for section in sections for entry in plan.get(section, [])]) * micro),
        },
        "materials": materials,
        "tracks": tracks,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")
    return output


def audio_waveform(path: Path, points: int = 900) -> list[float]:
    points = max(80, min(2400, int(points)))
    with tempfile.TemporaryDirectory(prefix="video-workstation-wave-") as folder:
        raw = Path(folder) / "audio.raw"
        command = [
            ffmpeg_binary(), "-hide_banner", "-i", str(path),
            "-map", "a:0?", "-ac", "1", "-ar", "8000",
            "-f", "s16le", str(raw)
        ]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
        if result.returncode != 0 or not raw.exists():
            return []
        data = raw.read_bytes()
    if not data:
        return []
    chunk = max(2, len(data) // (points * 2))
    normalized = []
    for start in range(0, len(data) - 1, chunk * 2):
        sample = data[start:start + chunk * 2]
        peak = max(abs(int.from_bytes(sample[index:index + 2], byteorder="little", signed=True))
                   for index in range(0, len(sample) - 1, 2))
        normalized.append(min(1.0, peak / 32768.0))
    if len(normalized) > points:
        step = len(normalized) / points
        return [normalized[int(index * step)] for index in range(points)]
    return normalized


def video_thumbnails(path: Path, count: int = 10, width: int = 160) -> list[dict[str, Any]]:
    count = max(1, min(30, int(count)))
    width = max(80, min(360, int(width)))
    asset = probe(path)
    duration = max(0.1, float(asset["duration"]))
    with tempfile.TemporaryDirectory(prefix="video-workstation-thumbs-") as folder:
        folder_path = Path(folder)
        pattern = folder_path / "frame-%02d.jpg"
        command = [
            ffmpeg_binary(), "-hide_banner", "-y", "-i", str(path),
            "-vf", f"fps={count / duration:.6f},scale={width}:-2", "-frames:v", str(count), str(pattern)
        ]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
        if result.returncode != 0:
            raise PipelineError(result.stderr.strip()[-2000:] or "Thumbnail extraction failed")
        thumbs = []
        for index, file in enumerate(sorted(folder_path.glob("frame-*.jpg"))):
            thumbs.append({
                "time": min(duration, duration * (index + 0.5) / count),
                "dataUrl": "data:image/jpeg;base64," + base64.b64encode(file.read_bytes()).decode("ascii")
            })
    return thumbs


def visual_signals(path: Path, samples: int = 16) -> list[dict[str, Any]]:
    samples = max(3, min(40, int(samples)))
    asset = probe(path)
    duration = max(0.1, float(asset["duration"]))
    with tempfile.TemporaryDirectory(prefix="video-workstation-visual-") as folder:
        folder_path = Path(folder)
        pattern = folder_path / "probe-%03d.png"
        command = [
            ffmpeg_binary(), "-hide_banner", "-y", "-i", str(path),
            "-vf", f"fps={samples / duration:.6f},scale=96:-2", "-frames:v", str(samples), str(pattern)
        ]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
        if result.returncode != 0:
            raise PipelineError(result.stderr.strip()[-2000:] or "Visual sampling failed")
        frames = sorted(folder_path.glob("probe-*.png"))
        signals: list[dict[str, Any]] = []
        previous: tuple[int, int, int] | None = None
        for index, file in enumerate(frames):
            with Image.open(file).convert("RGB") as image:
                pixels = list(image.getdata())
                count = len(pixels)
                brightness = sum(sum(pixel) / 3 for pixel in pixels) / count / 255
                saturation = sum(
                    (max(pixel) - min(pixel)) / max(1, max(pixel)) for pixel in pixels
                ) / count
                centers = [(0, 0), (0, 1), (1, 0), (1, 1)]
                region_pixels: list[tuple[int, int, int]] = []
                for row, col in centers:
                    y = int(image.height * (row * 0.5 + 0.25))
                    x = int(image.width * (col * 0.5 + 0.25))
                    region_pixels.append(image.getpixel((x, y)))
                center = tuple(sum(channel[i] for channel in region_pixels) // len(region_pixels) for i in range(3))
                motion = 0.0
                if previous:
                    motion = sum(abs(previous[i] - center[i]) for i in range(3)) / 255 / 3
                previous = center
            signals.append({
                "mediaId": asset["id"],
                "start": duration * index / samples,
                "end": duration * (index + 1) / samples,
                "brightness": round(brightness, 5),
                "saturation": round(saturation, 5),
                "motion": round(min(1.0, motion * 2), 5),
                "objects": []
            })
    return signals


def whisper_model_instance():
    global whisper_model
    with whisper_lock:
        if whisper_model is None:
            from faster_whisper import WhisperModel

            whisper_model = WhisperModel(WHISPER_MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=2)
    return whisper_model


def speech_analysis(path: Path, asset_id: str) -> dict[str, Any]:
    segments, info = whisper_model_instance().transcribe(
        str(path),
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 350},
    )
    transcript: list[dict[str, Any]] = []
    for index, segment in enumerate(segments):
        text = segment.text.strip()
        if not text:
            continue
        transcript.append({
            "id": f"speech-{index + 1}",
            "mediaId": asset_id,
            "start": max(0.0, float(segment.start)),
            "end": min(float(segment.end), float(info.duration)),
            "text": text,
            "language": info.language,
            "confidence": float(segment.avg_logprob),
        })
    return {"language": info.language, "segments": transcript}


def format_srt_time(value: float) -> str:
    milliseconds = max(0, int(round(value * 1000)))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def create_caption_file(captions: list[dict[str, Any]]) -> Path:
    captions = sorted(captions, key=lambda item: float(item.get("timelineStart", 0)))
    file = Path(tempfile.gettempdir()) / f"video-workstation-{uuid.uuid4().hex}.srt"
    lines: list[str] = []
    for index, caption in enumerate(captions, 1):
        start = float(caption.get("timelineStart", 0))
        end = start + float(caption.get("duration", 0))
        if end <= start:
            continue
        lines.extend([
            str(index),
            f"{format_srt_time(start)} --> {format_srt_time(end)}",
            str(caption.get("text", "")).strip(),
            "",
        ])
    file.write_text("\n".join(lines), encoding="utf-8")
    return file


def effect_track(clip: dict[str, Any], property: str) -> dict[str, Any] | None:
    for track in clip.get("effects", []):
        if track.get("property") != property:
            continue
        return track
    return None


def effect_keyframes(clip: dict[str, Any], property: str) -> list[tuple[float, float]]:
    track = effect_track(clip, property)
    if not track:
        return []
    points = sorted(track.get("keyframes", []), key=lambda item: float(item.get("time", 0)))
    return [(float(item.get("time", 0)), float(item.get("value", 0))) for item in points]


def sample_effect_value(clip: dict[str, Any], property: str, default: float) -> float:
    keyframes = effect_keyframes(clip, property)
    if not keyframes:
        return default
    first_time, first_value = keyframes[0]
    if first_time > 0:
        return default
    return first_value


def keyframe_expr(
    clip: dict[str, Any], property: str, default: float, time_var: str = "T"
) -> str | None:
    """Build a piecewise-linear FFmpeg expression from local keyframes."""
    keyframes = effect_keyframes(clip, property)
    if not keyframes:
        return None
    if len(keyframes) == 1:
        return number_literal(keyframes[0][1])
    first_time, first_value = keyframes[0]
    if first_time > 0:
        keyframes.insert(0, (0.0, default))
    parts: list[str] = []
    conditions: list[str] = []
    for index, (start_time, start_value) in enumerate(keyframes[:-1]):
        end_time, end_value = keyframes[index + 1]
        if abs(end_time - start_time) < 1e-9:
            continue
        lower = f"gte({time_var},{start_time:.9f})" if start_time > 0 else None
        upper = f"lte({time_var},{end_time:.9f})"
        conditions.append((lower, upper))
        slope = (end_value - start_value) / (end_time - start_time)
        value_at_start = start_value - slope * start_time
        if abs(slope) < 1e-12:
            value = number_literal(start_value)
        else:
            value = f"{number_literal(value_at_start)}+({time_var})*{number_literal(slope)}"
        if lower:
            parts.append(f"if({lower}*{upper},{value},")
        else:
            parts.append(f"if({upper},{value},")
    tail = number_literal(keyframes[-1][1])
    if not conditions:
        return tail
    parts.append(tail)
    parts.append(")" * len(conditions))
    return "".join(parts)


def number_literal(value: float) -> str:
    if not math.isfinite(value):
        return "0"
    if value == int(value) and abs(value) < 1e15:
        return str(int(value))
    return f"{value:.9f}".rstrip("0").rstrip(".")


def escape_filter_commas(expression: str) -> str:
    return expression.replace(",", "\\,")


def clamp_expr(expression: str, low: float, high: float) -> str:
    return f"min({number_literal(high)},max({number_literal(low)},{expression}))"


def replace_time_var(expression: str, time_var: str) -> str:
    return expression.replace(time_var, "t")


def ffmpeg_brightness(expression: str) -> str:
    return f"({expression}-1)/2"


directional_transitions = {
    "wipe-left", "wipe-right", "slide-left", "slide-right"
}


def transition_kinds(clip: dict[str, Any]) -> tuple[str, str]:
    return str(clip.get("transitionIn", "none")), str(clip.get("transitionOut", "none"))


def directional_transition(clip: dict[str, Any]) -> tuple[str, str]:
    start, end = transition_kinds(clip)
    return (
        start if start in directional_transitions else "none",
        end if end in directional_transitions else "none",
    )


def transition_fade(
    clip: dict[str, Any], video: bool
) -> tuple[float, float] | None:
    start, end = transition_kinds(clip)
    start = "none" if start in directional_transitions else start
    end = "none" if end in directional_transitions else end
    if start == "none" and end == "none":
        return None
    duration = max(0.0, float(clip.get("duration", 0)))
    if duration < 0.2:
        return None
    transition_duration = transition_duration_of(clip)
    fade_in = min(transition_duration, duration * 0.25) if start != "none" else 0.0
    fade_out = min(transition_duration, duration * 0.25) if end != "none" else 0.0
    if not video and start in ("fade", "dissolve"):
        fade_in = min(0.25, fade_in)
    if not video and end in ("fade", "dissolve"):
        fade_out = min(0.25, fade_out)
    return fade_in, fade_out


def transition_duration_of(clip: dict[str, Any]) -> float:
    try:
        value = float(clip.get("transitionDuration", 0.5))
    except (TypeError, ValueError):
        return 0.5
    return clamp(value, 0.05, 2.0)


def wipe_alpha_expression(
    kind: str,
    direction: str,
    duration: float,
    transition_duration: float,
    frame_rate: float,
) -> str:
    if direction == "in":
        progress = f"clip((N/{frame_rate:.9f})/{transition_duration:.9f},0,1)"
    else:
        offset = max(0.0, duration - transition_duration)
        progress = f"clip((N/{frame_rate:.9f}-{offset:.9f})/{transition_duration:.9f},0,1)"
    if kind == "wipe-left":
        boundary = f"W*{progress}" if direction == "in" else f"W*(1-{progress})"
        return f"255*lt(X,{boundary})"
    boundary = f"W*(1-{progress})" if direction == "in" else f"W*{progress}"
    return f"255*gte(X,{boundary})"


def slide_overlay_expression(
    kind: str,
    direction: str,
    position_x: str,
    timeline_start: float,
    transition_duration: float,
    duration: float,
) -> str:
    if direction == "in":
        progress = f"clip((t-{timeline_start:.9f})/{transition_duration:.9f},0,1)"
    else:
        offset = max(0.0, duration - transition_duration)
        progress = f"clip((t-{timeline_start + offset:.9f})/{transition_duration:.9f},0,1)"
    base = f"(main_w-overlay_w)/2+{position_x}"
    if kind == "slide-left":
        offset_expression = f"main_w*(1-{progress})" if direction == "in" else f"-main_w*{progress}"
        return f"{base}+{offset_expression}" if direction == "in" else f"{base}{offset_expression}"
    offset_expression = f"-main_w*(1-{progress})" if direction == "in" else f"main_w*{progress}"
    return f"{base}{offset_expression}"


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def export(plan: dict[str, Any], output: Path, on_progress: Any | None = None) -> dict[str, Any]:
    video_clips = [clip for clip in plan.get("video", []) if clip.get("path")]
    audio_clips = [clip for clip in plan.get("audio", []) if clip.get("path")]
    music_clips = [clip for clip in plan.get("music", []) if clip.get("path")]
    narration_clips = [clip for clip in plan.get("audio", []) if clip.get("narrationPending", False)]
    if not video_clips and not audio_clips and not music_clips:
        raise PipelineError("Export plan has no usable clips")

    args = [ffmpeg_binary(), "-hide_banner", "-y"]
    quality = plan.get("quality", {})
    try:
        crf = max(0, min(51, int(quality.get("crf", 20))))
    except (TypeError, ValueError):
        crf = 20
    preset = str(quality.get("preset", "medium") or "medium")
    for clip in video_clips + audio_clips + music_clips:
        args.extend(["-ss", str(clip["sourceStart"]), "-t", str(clip["duration"]), "-i", clip["path"]])

    scale = plan.get("meta", {}).get("width", 1920)
    height = plan.get("meta", {}).get("height", 1080)
    frame_rate = plan.get("meta", {}).get("frameRate", 30)
    captions = [item for item in plan.get("caption", []) if str(item.get("text", "")).strip()]
    caption_file: Path | None = None
    if captions:
        caption_file = create_caption_file(captions)
    filters: list[str] = []
    map_args: list[str] = []
    audio_stream_inputs: list[int] = []
    audio_mixin_labels: dict[int, str] = {}
    input_offset = 0
    for index in range(len(video_clips)):
        input_index = input_offset + index
        if not video_clips[index].get("hasAudio", True):
            continue
        if not video_clips[index].get("muted", False):
            audio_stream_inputs.append(input_index)
    input_offset += len(video_clips)
    independent_audio_inputs = [
        index for index in range(input_offset, input_offset + len(audio_clips))
        if not audio_clips[index - input_offset].get("muted", False)
    ]
    input_offset += len(audio_clips)
    music_audio_inputs = [
        index for index in range(input_offset, input_offset + len(music_clips))
        if not music_clips[index - input_offset].get("muted", False)
    ]

    ducking = plan.get("audioDucking", {}) if isinstance(plan.get("audioDucking", {}), dict) else {}
    ducking_enabled = bool(ducking.get("enabled", True)) and narration_clips and (audio_stream_inputs or music_audio_inputs)
    narration_ranges = [
        (
            max(0.0, float(clip.get("timelineStart", 0))),
            max(0.05, float(clip.get("timelineStart", 0)) + float(clip.get("duration", 0))),
        )
        for clip in narration_clips
    ]

    def ducking_expression() -> str:
        gain = clamp(float(ducking.get("gain", .3)), 0, 1)
        attack = max(.01, min(1.0, float(ducking.get("attack", .16))))
        release = max(.05, min(3.0, float(ducking.get("release", .45))))
        parts: list[str] = []
        for start, end in narration_ranges:
            parts.append(f"if(between(t,{start:.3f},{end:.3f}),{gain:.3f},")
            parts.append(
                f"if(lt(t,{start:.3f}),1-max(0,({start:.3f}-t)/{attack:.3f})*{1 - gain:.3f},"
                f"1-min(max((t-{end:.3f}),0)/{release:.3f},1)*{1 - gain:.3f})"
            )
            parts.append(")")
        return "".join(parts) if parts else "1"

    def background_ducking_expression() -> str:
        return ducking_expression() if ducking_enabled else "1"

    audio_mixin_inputs = audio_stream_inputs + independent_audio_inputs + music_audio_inputs

    if video_clips:
        timeline_duration = max(float(clip.get("timelineStart", 0)) + float(clip.get("duration", 0)) for clip in video_clips)
        filters.append(
            f"color=c=black:s={scale}x{height}:r={frame_rate}:d={timeline_duration}[base0]"
        )
        for index, clip in enumerate(video_clips):
            clip_label = f"clipv{index}"
            base_label = f"base{index}"
            output_label = f"base{index + 1}"
            timeline_start = float(clip.get("timelineStart", 0))
            duration = max(0.0, float(clip.get("duration", 0)))
            transform = clip.get("transform", {})
            position_y = float(transform.get("y", 0))
            chain = [f"scale={scale}:{height}:force_original_aspect_ratio=decrease", "setsar=1"]
            scale_expr = keyframe_expr(clip, "scale", 1)
            position_expr = keyframe_expr(clip, "position", 0)
            rotation_expr = keyframe_expr(clip, "rotation", 0)
            opacity_expr = keyframe_expr(clip, "opacity", 1)
            if scale_expr:
                scale_expr = replace_time_var(clamp_expr(scale_expr, .05, 10), "T")
                chain.append(
                    f"scale=w='max(2,trunc(iw*({scale_expr}))/2)*2':"
                    f"h='max(2,trunc(ih*({scale_expr}))/2)*2':eval=frame"
                )
                chain.insert(0, f"scale={scale}:{height}:force_original_aspect_ratio=decrease")
            elif static_scale := clamp(float(transform.get("scale", 1)), .05, 10):
                if static_scale != 1:
                    chain.append(f"scale=trunc(iw*{static_scale}/2)*2:trunc(ih*{static_scale}/2)*2")
            if rotation_expr:
                chain.append(f"rotate='{rotation_expr}*PI/180':ow=iw:oh=ih:c=black@0")
            elif rotation := clamp(float(transform.get("rotation", 0)), -360, 360):
                chain.append(f"rotate={rotation}*PI/180:ow=iw:oh=ih:c=black@0")
            if opacity_expr:
                # FFmpeg's colorchannelmixer does not accept per-frame expressions.
                # Keep exporting the first keyframe until a mask-based renderer lands.
                opacity = clamp(sample_effect_value(clip, "opacity", 1), 0, 1)
            else:
                opacity = clamp(float(transform.get("opacity", 1)), 0, 1)
            transition_in, transition_out = directional_transition(clip)
            clip_transition_duration = transition_duration_of(clip)
            needs_alpha_mask = opacity < 1 or transition_in != "none" or transition_out != "none"
            if needs_alpha_mask:
                chain.append("format=rgba")
                if opacity < 1:
                    chain.append(f"colorchannelmixer=aa={opacity}")
            if transition_in != "none":
                transition_duration = min(clip_transition_duration, duration * .25)
                chain.extend([
                    "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                    f"a='{escape_filter_commas(wipe_alpha_expression(transition_in, 'in', duration, transition_duration, frame_rate))}'"
                ])
            if transition_out != "none":
                transition_duration = min(clip_transition_duration, duration * .25)
                chain.extend([
                    "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                    f"a='{escape_filter_commas(wipe_alpha_expression(transition_out, 'out', duration, transition_duration, frame_rate))}'"
                ])
            brightness = sample_effect_value(
                clip, "brightness", clamp(float(transform.get("brightness", 1)), -1, 3)
            )
            contrast = sample_effect_value(
                clip, "contrast", clamp(float(transform.get("contrast", 1)), 0, 3)
            )
            saturation = sample_effect_value(
                clip, "saturation", clamp(float(transform.get("saturation", 1)), 0, 3)
            )
            brightness_keyframes = keyframe_expr(clip, "brightness", 1)
            contrast_expr = keyframe_expr(clip, "contrast", 1)
            saturation_expr = keyframe_expr(clip, "saturation", 1)
            if brightness_keyframes or contrast_expr or saturation_expr:
                brightness_part = clamp_expr(brightness_keyframes or number_literal(brightness), -1, 1)
                contrast_part = clamp_expr(contrast_expr or number_literal(contrast), 0, 3)
                saturation_part = clamp_expr(saturation_expr or number_literal(saturation), 0, 3)
                brightness_part = escape_filter_commas(brightness_part)
                contrast_part = escape_filter_commas(contrast_part)
                saturation_part = escape_filter_commas(saturation_part)
                chain.append(
                    f"eq=brightness='{ffmpeg_brightness(brightness_part)}':"
                    f"contrast='{contrast_part}':"
                    f"saturation='{saturation_part}':eval=frame"
                )
            elif brightness != 1 or contrast != 1 or saturation != 1:
                chain.append(
                    f"eq=brightness={clamp((brightness - 1) / 2, -1, 1)}:"
                    f"contrast={clamp(contrast, 0, 3)}:saturation={clamp(saturation, 0, 3)}"
                )
            chain.append(f"setpts=PTS+{timeline_start}/TB")
            transition = transition_fade(clip, video=True)
            if transition:
                fade_in, fade_out = transition
                if fade_in > 0:
                    chain.append(f"fade=t=in:st=0:d={fade_in}")
                if fade_out > 0:
                    chain.append(f"fade=t=out:st={duration - fade_out:.9f}:d={fade_out}")
            filters.append(f"[{index}:v]{','.join(chain)}[{clip_label}]")
            position_x = position_expr or number_literal(clamp(float(transform.get("x", 0)), -4000, 4000))
            if position_expr:
                position_x = keyframe_expr(
                    clip, "position", 0, f"(t-{timeline_start:.9f})"
                ) or position_expr
            position_y_expr = number_literal(clamp(position_y, -4000, 4000))
            overlay_x = f"(main_w-overlay_w)/2+{position_x}"
            slide_kind, slide_direction = (
                (transition_in, "in")
                if transition_in.startswith("slide-")
                else (transition_out, "out")
            )
            if slide_kind.startswith("slide-"):
                overlay_x = slide_overlay_expression(
                    slide_kind,
                    slide_direction,
                    position_x,
                    timeline_start,
                    clip_transition_duration,
                    duration,
                )
            filters.append(
                f"[{base_label}][{clip_label}]overlay="
                f"x='{escape_filter_commas(overlay_x)}':y='(main_h-overlay_h)/2+{position_y_expr}':eval=frame:"
                "format=auto:enable='between(t,"
                f"{timeline_start},{timeline_start + float(clip.get('duration', 0))})'[{output_label}]"
            )
        final_base = f"base{len(video_clips)}"
        if caption_file:
            escaped = str(caption_file).replace("\\", "/").replace(":", "\\:")
            filters.append(
                f"[{final_base}]scale={scale}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={scale}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,"
                f"subtitles=filename='{escaped}':force_style='FontName=Arial,"
                "FontSize=54,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,"
                "BorderStyle=1,Outline=2,Shadow=0'[v]"
            )
        else:
            filters.append(
                f"[{final_base}]scale={scale}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={scale}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v]"
            )
        map_args.extend(["-map", "[v]"])
    if audio_mixin_inputs:
        for index in audio_mixin_inputs:
            clip = None
            if index < len(video_clips):
                clip = video_clips[index]
            elif index < len(video_clips) + len(audio_clips):
                clip = audio_clips[index - len(video_clips)]
            else:
                clip = music_clips[index - len(video_clips) - len(audio_clips)]
            volume = clamp(float(clip.get("volume", 1)), 0, 2)
            delay_ms = max(0, int(round(float(clip.get("timelineStart", 0)) * 1000)))
            clip_duration = max(0.0, float(clip.get("duration", 0)))
            filters.append(
                f"[{index}:a]volume={volume},aresample=48000,"
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
                f"adelay={delay_ms}:all=1[mix{index}]"
            )
            transition = transition_fade(clip, video=False)
            if transition:
                fade_in, fade_out = transition
                fade_parts: list[str] = []
                if fade_in > 0:
                    fade_parts.append(f"min(t/{fade_in:.9f},1)")
                if fade_out > 0:
                    fade_parts.append(f"min(max((({clip_duration:.9f}-t)/{fade_out:.9f}),0),1)")
                if len(fade_parts) == 1:
                    gain_expr = fade_parts[0]
                elif len(fade_parts) == 2:
                    gain_expr = f"min({fade_parts[0]},{fade_parts[1]})"
                else:
                    gain_expr = "1"
                gain_expr = f"min({gain_expr},{background_ducking_expression()})"
            else:
                gain_expr = background_ducking_expression()
            filters.append(f"[mix{index}]volume='{escape_filter_commas(gain_expr)}':eval=frame[amix{index}]")
            audio_mixin_labels[index] = f"[amix{index}]"
        mix_labels = "".join(audio_mixin_labels[index] for index in audio_mixin_inputs)
        if len(audio_mixin_inputs) == 1:
            filters.append(f"{mix_labels}anull[a]")
        else:
            filters.append(f"{mix_labels}amix=inputs={len(audio_mixin_inputs)}:normalize=0:dropout_transition=0[a]")
        map_args.extend(["-map", "[a]"])
    args.extend([
        "-filter_complex", ";".join(filters),
        *map_args,
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-c:a", "aac", "-b:a", "192k", "-shortest", str(output)
    ])
    output.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    progress_pattern = re.compile(r"time=([0-9]+):([0-9]+):([0-9]+(?:\.[0-9]+)?)")
    if video_clips:
        total = max(float(clip.get("timelineStart", 0)) + float(clip.get("duration", 0)) for clip in video_clips)
    elif audio_clips:
        total = max(float(clip.get("timelineStart", 0)) + float(clip.get("duration", 0)) for clip in audio_clips)
    else:
        total = max(float(clip.get("timelineStart", 0)) + float(clip.get("duration", 0)) for clip in music_clips)
    stderr_tail_lines: list[str] = []
    assert result.stderr is not None
    for line in result.stderr:
        stderr_tail_lines = (stderr_tail_lines + [line])[-8:]
        if on_progress and total > 0:
            match = progress_pattern.search(line)
            if match:
                hours, minutes, seconds = (float(value) for value in match.groups())
                on_progress(min(0.99, (hours * 3600 + minutes * 60 + seconds) / total))
    result.wait()
    if caption_file:
        caption_file.unlink(missing_ok=True)
    if result.returncode != 0:
        detail = "".join(stderr_tail_lines).strip()
        if not detail and result.stderr:
            detail = result.stderr.read()
        raise PipelineError(detail[-2000:] or "Export failed")
    return {
        "output": str(output.resolve().as_posix()),
        "videoClips": len(video_clips),
        "audioClips": len(audio_clips),
        "musicClips": len(music_clips),
        "animatedKeyframeTracks": sum(
            len(effect_keyframes(clip, prop))
            for clip in video_clips
            for prop in ("opacity", "scale", "position", "rotation", "brightness", "contrast", "saturation")
        )
    }


def update_job(job_id: str, **changes: Any) -> None:
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(changes)


def run_export_job(job_id: str, plan: dict[str, Any], output: Path) -> None:
    try:
        update_job(job_id, status="running", progress=0)
        result = export(plan, output, lambda value: update_job(job_id, progress=value))
        update_job(job_id, status="completed", progress=1, result=result)
    except Exception as error:
        update_job(job_id, status="failed", error=str(error))


def run_metadata_job(job_id: str, plan: dict[str, Any], output: Path, kind: str) -> None:
    try:
        update_job(job_id, status="running", progress=0)
        result_output = create_fcpxml(plan, output) if kind == "fcpxml" else create_jianying_draft(plan, output)
        update_job(job_id, status="completed", progress=1, result={"output": str(result_output.resolve().as_posix())})
    except Exception as error:
        update_job(job_id, status="failed", error=str(error))


def load_project_document() -> dict[str, Any] | None:
    if not PROJECT_FILE.exists():
        return None
    try:
        value = json.loads(PROJECT_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise PipelineError(f"Saved project is invalid: {error}") from error
    if not isinstance(value, dict) or not isinstance(value.get("project"), dict):
        raise PipelineError("Saved project is invalid")
    return value


def save_project_document(document: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(document, dict) or not isinstance(document.get("project"), dict):
        raise BadRequestError("Project document is required")
    PROJECT_FILE.parent.mkdir(parents=True, exist_ok=True)
    PROJECT_FILE.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "path": str(PROJECT_FILE.resolve().as_posix())}


class MediaHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def send_json(self, status: HTTPStatus, data: Any) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def send_error_json(self, status: HTTPStatus, message: str) -> None:
        self.send_json(status, {"error": message})

    def handle_internal_error(self, action: str, error: Exception) -> None:
        traceback.print_exc()
        self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"{action} failed: {error}")

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.end_headers()

    def read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise BadRequestError(f"Invalid JSON body: {error}") from error

    def resolve_path(self, raw: str) -> Path:
        value = raw.strip()
        if not value:
            raise BadRequestError("Media path is required")
        path = Path(raw).expanduser().resolve()
        if not path.exists() or not path.is_file():
            raise BadRequestError(f"Media file does not exist: {path}")
        return path

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = {key: value[0] for key, value in parse_qs(parsed.query).items()}
        try:
            if parsed.path == "/api/health":
                self.send_json(HTTPStatus.OK, {
                    "ok": True,
                    "ffmpeg": bool(shutil.which("ffmpeg") or (os.environ.get("FFMPEG_PATH") and Path(os.environ["FFMPEG_PATH"]).is_file())),
                    "ffprobe": bool(ffprobe_binary()),
                })
                return
            if parsed.path == "/api/media/stream":
                path = self.resolve_path(query.get("path", ""))
                size = path.stat().st_size
                mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
                range_header = self.headers.get("Range")
                start, end = 0, size - 1
                status = HTTPStatus.OK
                if range_header:
                    match = re.match(r"bytes=(\d*)-(\d*)", range_header)
                    if not match:
                        raise BadRequestError("Invalid Range header")
                    if match.group(1):
                        start = int(match.group(1))
                    if match.group(2):
                        end = int(match.group(2))
                    else:
                        end = min(size - 1, start + 1_000_000)
                    status = HTTPStatus.PARTIAL_CONTENT
                length = end - start + 1
                self.send_response(status)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Access-Control-Allow-Origin", "*")
                if status == HTTPStatus.PARTIAL_CONTENT:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                self.wfile.write(media_stream(path, start, length))
                return
            if parsed.path == "/api/analyze/scenes":
                path = self.resolve_path(query.get("path", ""))
                threshold = float(query.get("threshold", "0.28"))
                self.send_json(HTTPStatus.OK, scene_analysis(path, min(0.95, max(0.01, threshold))))
                return
            if parsed.path == "/api/analyze/speech":
                path = self.resolve_path(query.get("path", ""))
                asset_id = query.get("assetId", "media-source")
                if len(asset_id) > 128:
                    raise BadRequestError("Invalid asset id")
                self.send_json(HTTPStatus.OK, speech_analysis(path, asset_id))
                return
            if parsed.path == "/api/analyze/waveform":
                path = self.resolve_path(query.get("path", ""))
                points = int(query.get("points", "900"))
                self.send_json(HTTPStatus.OK, {"waveform": audio_waveform(path, points)})
                return
            if parsed.path == "/api/media/thumbnails":
                path = self.resolve_path(query.get("path", ""))
                count = int(query.get("count", "10"))
                width = int(query.get("width", "160"))
                self.send_json(HTTPStatus.OK, {"thumbnails": video_thumbnails(path, count, width)})
                return
            if parsed.path == "/api/analyze/visual":
                path = self.resolve_path(query.get("path", ""))
                samples = int(query.get("samples", "16"))
                self.send_json(HTTPStatus.OK, {"signals": visual_signals(path, samples)})
                return
            if parsed.path.startswith("/api/jobs/"):
                job_id = parsed.path[len("/api/jobs/"):]
                with jobs_lock:
                    job = dict(jobs.get(job_id, {}))
                if not job:
                    raise BadRequestError("Job not found")
                self.send_json(HTTPStatus.OK, {"id": job_id, **job})
                return
            if parsed.path == "/api/project":
                document = load_project_document()
                if document is None:
                    self.send_json(HTTPStatus.OK, {"project": None})
                    return
                self.send_json(HTTPStatus.OK, document)
                return
            self.send_error_json(HTTPStatus.NOT_FOUND, "Not found")
        except PipelineError as error:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(error))
        except Exception as error:
            self.handle_internal_error("Request", error)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            body = self.read_body()
            if parsed.path == "/api/media/probe":
                path = self.resolve_path(str(body.get("path", "")))
                self.send_json(HTTPStatus.OK, probe(path))
                return
            if parsed.path == "/api/media/transcode":
                source = self.resolve_path(str(body.get("source", "")))
                output = Path(str(body.get("output", ""))).expanduser().resolve()
                preset = str(body.get("preset", "medium"))
                command = [
                    ffmpeg_binary(), "-hide_banner", "-y", "-i", str(source),
                    "-c:v", "libx264", "-preset", preset, "-crf", "20",
                    "-c:a", "aac", "-b:a", "192k", str(output)
                ]
                output.parent.mkdir(parents=True, exist_ok=True)
                result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
                if result.returncode != 0:
                    raise PipelineError(result.stderr.strip()[-2000:] or "Transcode failed")
                self.send_json(HTTPStatus.OK, {"source": str(source), "output": str(output), "asset": probe(output)})
                return
            if parsed.path == "/api/export":
                plan = body.get("plan")
                if not isinstance(plan, dict):
                    raise BadRequestError("Export plan is required")
                output = Path(str(body.get("output", ""))).expanduser().resolve()
                if output.suffix.lower() != ".mp4":
                    raise BadRequestError("Only MP4 output is currently supported")
                job_id = uuid.uuid4().hex
                with jobs_lock:
                    jobs[job_id] = {
                        "kind": "export",
                        "status": "queued",
                        "progress": 0,
                        "output": str(output),
                    }
                job_executor.submit(run_export_job, job_id, plan, output)
                self.send_json(HTTPStatus.ACCEPTED, {"jobId": job_id, **jobs[job_id]})
                return
            if parsed.path == "/api/project":
                self.send_json(HTTPStatus.OK, save_project_document(body))
                return
            if parsed.path == "/api/tts":
                text = str(body.get("text", ""))
                output = body.get("output")
                result = tts_synthesis(
                    text,
                    Path(str(output)).expanduser().resolve() if output else None,
                    str(body.get("voice", "")) or None,
                    str(body.get("rate", "")) or None,
                )
                self.send_json(HTTPStatus.OK, result)
                return
            if parsed.path == "/api/narration/drafts":
                plan = body.get("plan")
                if not isinstance(plan, dict):
                    raise BadRequestError("Export plan is required")
                self.send_json(HTTPStatus.OK, {"drafts": narration_drafts(plan)})
                return
            if parsed.path == "/api/export/metadata":
                plan = body.get("plan")
                if not isinstance(plan, dict):
                    raise BadRequestError("Export plan is required")
                kind = str(body.get("kind", ""))
                if kind not in ("fcpxml", "jianying"):
                    raise BadRequestError("Unsupported metadata format")
                output = Path(str(body.get("output", ""))).expanduser().resolve()
                if not output.name:
                    raise BadRequestError("Output file is required")
                job_id = uuid.uuid4().hex
                with jobs_lock:
                    jobs[job_id] = {
                        "kind": f"export-{kind}",
                        "status": "queued",
                        "progress": 0,
                        "output": str(output),
                    }
                job_executor.submit(run_metadata_job, job_id, plan, output, kind)
                self.send_json(HTTPStatus.ACCEPTED, {"jobId": job_id, **jobs[job_id]})
                return
            self.send_error_json(HTTPStatus.NOT_FOUND, "Not found")
        except PipelineError as error:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(error))
        except Exception as error:
            self.handle_internal_error("Request", error)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), MediaHandler)
    sys.stderr.write(f"Media service listening on http://{HOST}:{PORT}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
