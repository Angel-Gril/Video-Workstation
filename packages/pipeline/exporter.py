#!/usr/bin/env python3
"""Timeline export CLI. Normalized plans use the same renderer as the local API."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


from media_server import PipelineError, export


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        plan = json.loads(Path(args.plan).expanduser().read_text(encoding="utf-8"))
        print(json.dumps(export(plan, Path(args.output).expanduser()), ensure_ascii=False))
    except PipelineError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
