#!/usr/bin/env python3
"""Synchronous Node command bridge used by the local Agent API."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
BRIDGE = Path(__file__).with_name("agent_bridge.ts")


class AgentBridgeError(RuntimeError):
    pass


def call_bridge(payload: dict[str, Any]) -> dict[str, Any]:
    npm_executable = shutil.which("npx.cmd") or shutil.which("npx")
    if not npm_executable:
        raise AgentBridgeError("Node.js/npx was not found; the Agent command bridge is unavailable")
    try:
        result = subprocess.run(
            [npm_executable, "tsx", str(BRIDGE)],
            input=json.dumps(payload, ensure_ascii=False),
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=str(ROOT),
            timeout=30,
            shell=False,
        )
    except subprocess.TimeoutExpired as error:
        raise AgentBridgeError("Agent command bridge timed out") from error
    if result.returncode != 0:
        raise AgentBridgeError(
            (result.stderr or result.stdout or "Agent command bridge failed").strip()[-2000:]
        )
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AgentBridgeError(f"Agent command bridge returned invalid JSON: {error}") from error
    return value
