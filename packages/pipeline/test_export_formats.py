#!/usr/bin/env python3

from __future__ import annotations

import unittest
from pathlib import Path

from export_formats import video_export_format_for


class ExportFormatTests(unittest.TestCase):
    def test_maps_supported_containers(self) -> None:
        self.assertEqual(
            video_export_format_for(Path("output.WEBM")),
            {"video": "libvpx-vp9", "audio": "libopus"},
        )
        self.assertEqual(
            video_export_format_for(Path("output.mp4")),
            {"video": "libx264", "audio": "aac"},
        )

    def test_rejects_unknown_containers(self) -> None:
        self.assertIsNone(video_export_format_for(Path("output.avi")))
        self.assertIsNone(video_export_format_for(Path("output")))


if __name__ == "__main__":
    unittest.main()
