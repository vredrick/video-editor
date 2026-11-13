# VideoHub on the RunPod workstation

VideoHub runs headless on a pod of the `gpu-workstation` volume (see the `runpod-workstation` skill). Claude drives it
with the `hub_*` tools from a shell (`node server/cli.js …`) over Jupyter; the hub stays on `127.0.0.1` inside the pod
and is **never** put on a public RunPod proxy port (its render queue can run shell commands).

| Thing | Where |
| --- | --- |
| Program (this repository) | `/workspace/videohub/app/` (its `data/` holds config, queue, caches) |
| Workspace | `/workspace/videohub/` : `films/` (one folder per film), `outputs/`, `sounds/`, `thumbnails/`, `archive/`, `trash/` |
| Node 22 + Chromium | the volume's `/workspace/webrender/node/bin/node` and `/workspace/webrender/browsers` |
| Hardware | CPU pod (`cpu3c`, 4–8 vCPU for full renders); a GPU pod adds the NVENC encoder (`--detect`) |

## First install (once per volume)
From Claude's cloud session: `git archive HEAD | gzip > videohub.tgz`, `put` it to `/workspace/videohub/videohub.tgz`
(under 4 MB, one call), then on the pod:
```bash
mkdir -p /workspace/videohub/app && tar -xzf /workspace/videohub/videohub.tgz -C /workspace/videohub/app
bash /workspace/videohub/app/runpod/pod_prep.sh
source /workspace/videohub/app/runpod/env.sh
node /workspace/videohub/app/scripts/init-config.mjs --workspace /workspace/videohub   # config + folders (--help)
node /workspace/videohub/app/scripts/init-config.mjs --example                            # the 10-second example film
cp /workspace/videohub/app/runpod/README.md /workspace/videohub/README.md
```
Updating: the same archive unpacked over `app/` (keeps `app/data/` and `app/node_modules/`).

## Every new pod
```bash
bash /workspace/videohub/app/runpod/pod_prep.sh      # ffmpeg, Chromium libraries, version check (~1 min)
source /workspace/videohub/app/runpod/env.sh         # in every shell that runs a hub_* tool
cd /workspace/videohub/app
node server/cli.js hub_workspace                     # starts the hub, prints the folders
node server/cli.js hub_render '{"project":"hello-film","mode":"full","wait":true}'
```
A render longer than a Jupyter call: drop `wait`, then poll with `hub_job`. The hub exits by itself 2 minutes after the
queue is empty. Deliver an output with jrun `get`, or push it to Drive with the volume's rclone.

## What differs from Windows
See `docs/LINUX.md`: no window (Explorer/Edge/folder picker), CPU limits with `nice` + `taskset`, cleanup moves items to
`/workspace/videohub/trash/<time>/` instead of the Recycle Bin, Chromium instead of Edge.
