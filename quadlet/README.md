# Quadlet units

Podman Quadlet units that run `yammer-server` and `opencode serve` as
rootless, systemd-managed containers — the two backend halves of Yammer. The
[client](../client/README.md) is deliberately not covered here: it needs a
microphone and headphones on whatever machine the person is using, which
isn't a fit for a headless container.

Images are built locally (there's nothing to pull from a registry) using
Quadlet's own `.build` unit type, so `systemctl start` is the only build step
— see [`../containers/`](../containers/) for the two `Containerfile`s.

## What's here

| File | Generates |
|---|---|
| `yammer.network` | `yammer-network.service` — a private network the other two containers share, so `yammer-server` can reach `yammer-opencode` by container name |
| `yammer-server.build` | `yammer-server-build.service` — builds the server image from [`../containers/yammer-server/Containerfile`](../containers/yammer-server/Containerfile) |
| `yammer-opencode.build` | `yammer-opencode-build.service` — builds the OpenCode image from [`../containers/yammer-opencode/Containerfile`](../containers/yammer-opencode/Containerfile) |
| `yammer-opencode.container` | `yammer-opencode.service` — `opencode serve`, reachable only from the `yammer` network, project directory and OpenCode's own config/credentials bind-mounted in |
| `yammer-server.container` | `yammer-server.service` — the Node server, `.env`-configured, published to `127.0.0.1:8765` for the client |

## Install

```sh
mkdir -p ~/.config/containers/systemd
cp quadlet/*.network quadlet/*.build quadlet/*.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start yammer-server.service   # pulls in the network, both builds, and yammer-opencode via dependencies
```

`server/.env` must already exist and be filled in (see
[`../server/README.md`](../server/README.md)) — `yammer-server.container`
reads it with `EnvironmentFile=`.

Check it worked:

```sh
systemctl --user status yammer-opencode.service yammer-server.service
journalctl --user -u yammer-server -u yammer-opencode -f
```

To start both on login/boot without running the command above every time:

```sh
systemctl --user enable yammer-server.service yammer-opencode.service
loginctl enable-linger "$USER"   # keeps user services running without an active login session
```

`loginctl enable-linger` is a systemd-wide setting, not a repo file — decide
for yourself whether you want it.

## Picking up code changes

The `.build` services are one-shot: they run once and cache. Editing
`server/src/` or the agent doesn't get picked up by `systemctl restart
yammer-server.service` alone — that restarts the *container*, not the image
build. Rebuild first:

```sh
systemctl --user restart yammer-server-build.service
systemctl --user restart yammer-server.service
```

Same pattern with `yammer-opencode-build`/`yammer-opencode` if the
`Containerfile` changes (rare — it just pins a pacman package).

## Design notes and gotchas

- **`YAMMER_PROJECT_DIR` means something different here than in
  `server/.env`.** The value is only ever sent to OpenCode as its `directory`
  parameter (`server/src/opencode/client.ts`) — it's resolved on the
  filesystem of whichever process *is* OpenCode, never read locally by
  `yammer-server`. Containerized, that's `yammer-opencode`'s filesystem, where
  the repo is mounted at `/workspace`. `yammer-server.container` sets
  `Environment=YAMMER_PROJECT_DIR=/workspace` to override whatever host path
  `.env` has — Podman's env precedence puts `--env` above `--env-file`
  unconditionally (`podman-run(1)`'s `ENVIRONMENT` section), so this wins
  regardless of where either key appears in the unit file.
- **`YAMMER_HOST=0.0.0.0` inside the container is not the footgun
  `server/README.md` warns about.** That guidance is about binding a
  host-reachable interface directly; inside the container it only binds every
  interface *in the container's own network namespace*, which nothing outside
  Podman can reach. `PublishPort=127.0.0.1:8765:8765` in
  `yammer-server.container` is what actually controls host-facing exposure —
  change the IP there (e.g. to a Tailscale address) to open it up, same
  tradeoff the README describes for a non-containerized run.
- **`yammer-opencode`'s data/config mounts are the same ones a host-run
  `opencode serve` would use** (`~/.local/share/opencode`,
  `~/.config/opencode`) — including `auth.json`. Don't run both at once
  against the same directories; concurrent writers to `opencode.db`
  (sqlite) will corrupt state, not merge cleanly.
- **`EnvironmentFile=` here is systemd's parser, not Node's.** `server/.env`
  is normally read by `client/.../env.py`'s hand-rolled port of Node's
  `process.loadEnvFile`, which supports backtick-quoted values. Under Quadlet
  it's systemd doing the parsing instead, and systemd's `EnvironmentFile=`
  quoting rules aren't identical. Not an issue for anything currently in
  `.env` (no quoted values), but worth knowing before adding one.
- **No GPU passthrough.** `server/README.md`'s CUDA offload section needs
  `onnxruntime-node`'s CUDA EP binary and the CUDA runtime libraries visible
  at the paths Node loads them from — none of that is wired into
  `containers/yammer-server/Containerfile` or `yammer-server.container`.
  `YAMMER_TTS_DTYPE=q4` (CPU, real-time) is what this repo's `.env` already
  uses; if GPU offload is worth it later, it means `--device nvidia.com/gpu=0`
  (or the older `--gpus` flag) in a `PodmanArgs=` line plus the CUDA library
  setup the README describes, done as a follow-up rather than folded in here
  speculatively.
