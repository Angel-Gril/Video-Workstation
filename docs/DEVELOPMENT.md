# Development

```bash
npm install
npm run test
npm run typecheck
npm run dev
```

Open `http://127.0.0.1:5173`.

FFmpeg and ffprobe must be installed before media probing or export is used. On Windows, add them to `PATH`
or provide the executable locations in environment variables.

The local media service also uses `faster-whisper` for speech analysis:

```bash
pip install faster-whisper
```

Speech recognition currently runs locally with the `base` model, CPU execution, and int8 compute.
The first run downloads model weights; later requests reuse the loaded model.

## Workstation Areas

- Left: asset library, speech/scene results, and AI planner inputs.
- Center: source or timeline preview, transport controls, multi-track timeline, clip drag/trim,
  zoom, track states, and timeline seeking.
- Right: explainable plan review, accepted/rejected segments, clip and caption properties,
  and export settings.

Export quality is passed from the UI into the local FFmpeg pipeline as `crf` and `preset`.

## Local End-to-End Script

`.vite-e2e.mjs` is a local verification script, not part of the published package. Start both services
with `npm run dev`, then run:

```bash
node .vite-e2e.mjs
```

It resets the local saved project, imports `sample.mp4`, runs speech and scene analysis, generates a
plan, accepts the first candidate, applies it, saves and reloads, trims and undoes, then checks that
the restored label and saved clip count remain consistent. It also captures `workstation-complete.png`.
