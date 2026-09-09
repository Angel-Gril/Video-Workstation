#!/usr/bin/env python3
"""Container-to-codec mapping shared by the HTTP service and export CLI."""

from __future__ import annotations

from pathlib import Path
from typing import Any


VIDEO_EXPORT_FORMATS: dict[str, dict[str, str]] = {
    ".mp4": {"video": "libx264", "audio": "aac"},
    ".mov": {"video": "libx264", "audio": "aac"},
    ".mkv": {"video": "libx264", "audio": "aac"},
    ".webm": {"video": "libvpx-vp9", "audio": "libopus"},
    ".m4v": {"video": "libx264", "audio": "aac"},
}


def video_export_format_for(path: Path) -> dict[str, str] | None:
    return VIDEO_EXPORT_FORMATS.get(path.suffix.lower())
