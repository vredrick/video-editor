# VideoHub on Linux (the RunPod workstation)

Windows stays the home platform; on Linux the same server runs **headless** (a RunPod pod has no screen). Install and
daily use on the pod: [runpod/README.md](../runpod/README.md). What the code does differently (`IS_WIN` in
`server/util.js`):

| Part | Windows | Linux |
|---|---|---|
| Window, Explorer, folder picker, toasts | Edge `--app`, `explorer.exe`, a WinForms dialog | none: `VIDEOHUB_NO_WINDOW` is set by `util.js` |
| Browser for renders | Edge, else Chrome | `CHROME`/`VIDEOHUB_BROWSER`, a system Chromium/Chrome, else the newest Playwright Chromium in `PLAYWRIGHT_BROWSERS_PATH`, `/workspace/webrender/browsers` or `/opt/pw-browsers` (`linuxBrowser`). The queue passes it to render scripts as `CHROME`; `render.js` adds `--no-sandbox` when running as root |
| Render protection (`guard.js`) | priority + affinity through PowerShell | `os.setPriority` (nice) + `taskset` on the tree read from `/proc` (`procTree`); Stop kills that tree |
| Cleanup (`janitor.js`) | Recycle Bin | moved (renamed, never copied and deleted) to `<workspace>/trash/<time>/<full path>` (`trashStream`); another disk: left untouched |
| Programs holding RAM | PowerShell | `ps` |
| Default workspace | `Documents\VideoHub` | `/workspace/videohub` when `/workspace` exists, else `~/VideoHub` |
| Settings folder (`APPDATA`) | `%APPDATA%` | `$XDG_CONFIG_HOME` or `~/.config` |
| Start with Windows | Run key | not offered |

Paths inside VideoHub are compared with one slash style (`scan.js` `category`, `outputs.js`, `hub.js`), so the same
rules hold for `render/chunks` and `render\chunks`. `setup.ps1`, `open.vbs` and `update.ps1` are Windows only; on Linux
`scripts/init-config.mjs` does the setup part (`--workspace`, `--example`, `--detect`).

Testing on Linux: `npm test` and the scratch test hub from ARCHITECTURE.md work unchanged; a scratch copy of
`examples/hello-film` renders through the queue (full and partial) with the Chromium found above.
