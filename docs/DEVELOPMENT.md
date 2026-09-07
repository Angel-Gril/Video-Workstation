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

## Git Workflow

Use the repository's `main` branch as the reviewed integration branch. Each development increment
follows this order:

1. Create a focused feature branch from `main`.
2. Implement the smallest coherent slice and update documentation where behavior changes.
3. Run `npm run typecheck` and `npm test -- --run` before every commit.
4. Commit with a conventional subject, push the feature branch, and fast-forward `main` only after
   verification succeeds.

```bash
git switch -c feature/transition-rendering
# implement + verify
git commit -m "feat: render directional transitions"
git push -u origin feature/transition-rendering
git switch main
git merge --ff-only feature/transition-rendering
git push origin main
```

Windows development must expose `FFMPEG_PATH` and `FFPROBE_PATH` to the Python media service when
the binaries are not already on `PATH`.
