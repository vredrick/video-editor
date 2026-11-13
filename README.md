# VideoHub

**A local review studio and render queue for videos that Claude Code writes as code.**
You ask Claude Code for a video; it builds the film as a web page that draws every frame in code. VideoHub plays that
film straight from its code — no render — so you can watch it, step through frames, draw on a frame and write what is
wrong. One click sends your notes to Claude, Claude fixes the code, the open preview reloads by itself, and only when
you are happy do you render — once, in a queue that keeps your PC usable, and later re-rendering only the seconds that
changed. It is for people who make explainers, shorts and animations with Claude Code and are tired of rendering a
whole film to check one fix.

> **Windows 10/11**, plus a headless Linux mode for a RunPod GPU/CPU pod ([runpod/README.md](runpod/README.md),
> [docs/LINUX.md](docs/LINUX.md)): there Claude drives the render queue and notes with the `hub_*` tools.

![Live preview with a note on a frame](docs/screenshots/review-live-preview.png)

## Features
- **Projects** — every film in your watched folders with its videos, versions, notes and disk use; a live cover for
  films that have no video yet.
- **Live preview, no render** — plays a film from its page (`window.renderOut(t)`), frame-accurate, with its sound,
  scenes and narration on a timeline. Changing the code reloads the open preview in place.
- **Review notes** — click or draw on any frame (or pick a frame range), type what is wrong. **Send to Claude** copies
  a short message; Claude reads the notes (time, frame, chunk, a close-up picture of your drawing) with `hub_notes`.
- **Check fixes** — a tour through the notes Claude marked fixed, with before/after; "Still there" sends one back.
- **Render queue** — one render at a time on the PC, waits for renders started elsewhere, progress and ETA, a
  render dialog with size/fps/workers/encoder, a copy to any folder, a Windows notification when it is done.
- **Partial re-render** — a film rendered in 2-second chunks re-renders only the chunks your notes touched, joins the
  film again and saves `film_vN.mp4` with the changed ranges; **Watch only the changes** plays just those.
- **Render protection** (optional agent) — see below.
- **Recent renders & outputs folder** — every finished render, newest first; each one also hard-linked into one
  outputs folder (a folder per day, no extra disk space).
- **Disk cleanup** — what can safely go (old chunks, silent copies, browser profiles, check frames, old versions) and
  why; always to the Recycle Bin or the archive, never deleted outright, always with your approval.
- **Sound** — mute/solo/levels per stem, remove the music, duck it under a range, add sounds from your library or
  disk on the timeline; renders use the rebuilt mix.
- **Thumbnail Studio** — sketch a thumbnail (posed mannequins, objects, text, camera/depth/light), send the brief to
  Claude, which makes the variants; annotate a variant, add the final text in code.
- **Claude tools (MCP)** — `hub_live`, `hub_notes`, `hub_note_update`, `hub_render`, `hub_job`, `hub_project`, `hub_workspace`,
  `hub_register_version`, `hub_cleanup`, `hub_thumb_*`, `hub_review_*` (the claude.ai review page with Send to Claude: docs/REVIEW-PAGE.md); the same tools work from a shell (`node server/cli.js`).

![Projects](docs/screenshots/projects.png)

### Render protection and speed
Built into the VideoHub server (plain Node and Windows' own tools, no extra program), it keeps long renders from
freezing the PC:
- **CPU limit** — every render VideoHub starts runs on a share of the processor cores (default 90 %) and at low
  priority; Windows passes both on to the Chrome and ffmpeg processes the render starts. Presets *Full power /
  Balanced / Quiet*, or "full power for 1–8 h".
- **RAM slow mode** — when free RAM falls below a threshold, the newest render slows down to a few cores at the lowest
  priority instead of being killed (the oldest keeps going unless RAM is critical) and speeds up again when RAM frees.
- **Slow down / Normal speed / Stop** per render on the Renders page, or for all of them at once.
- **One render at a time**, and the queue waits while another session is rendering; the Renders page also lists
  programs holding a lot of RAM (it never closes anything).
- **Partial re-renders** of only the fixed chunks, and per-render workers / encoder and fps options.
- **Faster renders, same quality** — the film template reads frames straight from the canvas (lossless, no JPEG) and
  encodes on the graphics card when the PC has one (NVIDIA NVENC, AMD AMF, Intel Quick Sync; else x264). On the test PC
  the example film rendered ~1.3× faster. Settings → *Render speed*; details and measurements:
  [docs/RENDER-SPEED.md](docs/RENDER-SPEED.md).
All thresholds are sliders on the Renders page (the RAM range scales with your machine's memory). Without the agent
VideoHub works the same; renders just run unprotected.

![Renders](docs/screenshots/renders.png)

## Requirements
- Windows 10 or 11
- [Node.js 22+](https://nodejs.org) — `winget install -e --id OpenJS.NodeJS.LTS`
- ffmpeg on PATH — `winget install -e --id Gyan.FFmpeg`
  (setup checks both and tells you the exact command to paste if one is missing; then run SETUP.cmd again)
- Microsoft Edge (built in) or Google Chrome — renders drive it headless
- [Claude Code](https://claude.com/claude-code) — for the Claude side
- Optional: the .NET Framework 4 C# compiler (ships with Windows) for the render protection agent
- Optional: a graphics card with a video encoder (most NVIDIA, AMD and Intel ones) for faster renders

## Install
### The easy way: let Claude Code install it
1. Download the ZIP (or `git clone <this repository> VideoHub`) and unpack it anywhere you like.
2. Open that folder in [Claude Code](https://claude.com/claude-code) and say: **"Install VideoHub for me."**
3. Claude checks what your PC has, asks you a few plain questions in its own window (where your video work should
   live, whether to use the graphics card, whether to add the example film …), then runs the setup once with your
   answers and tells you what to do next. You approve each command it runs; you never type one yourself.
4. Open **VideoHub** from the Desktop shortcut and start a **new** Claude Code session so it sees the tools.

### By hand (3 steps)
1. `git clone <this repository> VideoHub` anywhere you like (or download the ZIP and unpack it).
2. Double-click **`SETUP.cmd`**. It checks the requirements, installs the packages, builds the agent, registers the
   `videohub` MCP server for Claude Code and installs the `videohub` skill, then asks a few plain questions — press
   Enter for the recommended answer:
   - **Where should your video work live?** One workspace folder (default `Documents\VideoHub`) with `films`,
     `outputs` (every finished render), `sounds`, `thumbnails` and `archive`, and a `README.txt` saying what each is.
   - Video folders it found on your Desktop / in Documents: watch them too? (default no; Settings can turn them on later)
   - Your graphics card can encode video: use it for renders? (default yes; only asked when it can)
   - Add the review-before-render rule to `~/.claude/CLAUDE.md`? · Desktop shortcut? · Start with Windows? (default no)
     · Add the example film?
   It ends with what to do next. Running it again keeps every answer and never moves or overwrites your folders or
   settings. `setup.ps1 -Yes` takes every recommended answer, each question also has a parameter (see the top of
   `setup.ps1`, e.g. `-Workspace D:\Videos\VideoHub`), and `setup.ps1 -DryRun` prints every step without changing
   anything.
3. Open **VideoHub** from the Desktop shortcut. Start a new Claude Code session so it sees the tools.

## Your first film
1. If setup added the example film, its card is on the Projects page. Otherwise the page shows **Welcome to
   VideoHub** with your workspace and films folder (`<workspace>\films`): click **▶ Add the example film**.
2. Click its card: it opens in the **live preview**. Press Space, step with ← →, click on the video to leave a note.
3. Press **🎬 Render** → *Full film*: the queue renders 5 two-second chunks and saves `hello-film_v1.mp4` with sound.
4. Leave a note on a frame, change `film.js` (e.g. a colour), then **🎬 Render** → *Only the fixed parts*: only the
   touched chunks are rendered again → `hello-film_v2.mp4`, and **Watch only the changes** plays them.
What a film folder must contain for each feature: [docs/PROJECT-CONTRACT.md](docs/PROJECT-CONTRACT.md). New films start
from [templates/new-film](templates/new-film).

## How working with Claude goes
1. **Ask** Claude Code for a video. It builds the film as code from the template (the `videohub` skill tells it how).
2. **Preview** — when it plays, Claude calls `hub_live`: VideoHub jumps to the film. Claude stops and waits; it does
   not render.
3. **Notes** — you watch, leave notes on frames, press **Send to Claude** and paste the message into the chat.
4. **Fix** — Claude reads them with `hub_notes`, fixes the code (your open preview updates by itself) and marks each
   note fixed with a one-line reply. Repeat 3–4 as often as you like.
5. **Render** — when you say so, Claude renders once through `hub_render` (or you press 🎬 Render). Later fixes
   re-render only the changed chunks. You check them with *Watch only the changes* and the *Check fixes* tour.
If the MCP tools are not loaded in a session, Claude uses `node <VideoHub>\server\cli.js <tool> "<json>"`.

## Optional integrations
| Feature | Needs | Without it |
|---|---|---|
| Ready-made sound effects | a 3D studio engine with `engine/audio/synth.js` (`studioDir` in Settings) | your own sound folder and files from disk |
| Scene editor / 2D layers in the preview | the page includes the hooks from `engine-hooks/` | those editors are hidden |
| Snipp export status | Snipp writing `.renders\*.json` in a watched folder | not shown |
Settings → *Optional parts on this computer* shows what was found.

## Security
VideoHub is a local tool. The server listens on **127.0.0.1 only** and refuses requests with a foreign Host, cross-site
requests from other web pages and writes with a foreign Origin. Its render queue can run shell commands for your
projects, so **never expose port 7788** (no port forwarding, no tunnels, no `0.0.0.0` proxies). It only serves files
inside your watched folders, the archive and its own folders.

## Uninstall
Run `powershell -ExecutionPolicy Bypass -File uninstall.ps1` (`-DryRun` first to see what it would do). It stops this
install's server and agent, removes the MCP server, the skill and the rule block it added (only if they belong to this
install), the Desktop shortcut and the start-up entry. Your films, their notes, the outputs folder and this folder stay;
delete them yourself if you want.

## Troubleshooting
- **The page is blank** — open it in a browser and look at the console; a missing Node 22 or a broken update are the
  usual causes. Restart with the Desktop shortcut.
- **Claude does not see `hub_*` tools** — start a new Claude Code session; `claude mcp list` should show `videohub`.
  Run SETUP.cmd again if not.
- **"This folder is not a project VideoHub knows"** — put the film inside a watched folder or add its parent folder
  in Settings → Watched folders.
- **"The live preview could not open"** — the page lacks `window.renderOut(t)` / `window.READY`; see
  PROJECT-CONTRACT.md. The message says what is missing.
- **Partial renders refused** — the render script is not chunked (family A) or the film length is unknown:
  `hub_project({set:{render:{env:{DUR:"…"}}}})`.
- **Renders fail at once** — ffmpeg or Edge/Chrome missing (Settings → Tools), or `puppeteer-core` missing for a
  film's render script (VideoHub ships one; run `npm install` in VideoHub's folder).
- **Port 7788 is taken** — set `"port"` in `data\config.json`.
- **Coming from an older (Turkish) build** — see [docs/MIGRATING.md](docs/MIGRATING.md).

## Development
`npm test` runs the suites; see [CLAUDE.md](CLAUDE.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License
[MIT](LICENSE) © 2026 VideoHub contributors.
