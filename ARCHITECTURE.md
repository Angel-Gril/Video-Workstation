# Architecture

## Product Flow

1. **Ingest** — media import and probing produce normalized assets and project metadata.
2. **Understand** — speech, scenes, captions, and narrative drafts are generated from the same media context.
3. **Plan** — the narrative planner converts intent and analysis results into executable timeline commands.
4. **Edit** — the same command layer serves human gestures, agent proposals, and batch scripts.
5. **Render** — export builds a normalized plan and invokes the command-line media engine.

## Data Model

The project is a portable directory concept backed by a single normalized JSON document:

- `media`: normalized asset records
- `timeline.tracks[]`: ordered video, audio, caption, and music tracks
- `timeline.clips[]`: immutable clip records with source range, timeline range, transform, effects, and keyframes
- command history: replayable operations and inverse operations for undo

## Command Layer

All modifications pass through one reducer. UI interactions and AI-generated plans emit the same command objects, so proposals can be validated before execution and rejected when they violate project invariants.

## Extension Points

- Local inference adapters for ASR, scene analysis, and speech synthesis.
- External agent tools that issue commands rather than mutate state directly.
- Exporters that transform the timeline into renderer-specific plans.
