# Cairn

**Your files, marked and guarded.** A lightweight Windows desktop utility
(Tauri 2 + Rust + React + Tailwind) that watches memory and disk, finds the
dev caches quietly eating your drive, and locks the folders you can't
afford to lose at the NTFS level.

![version](https://img.shields.io/badge/version-0.1.0-EE9A35)
![platform](https://img.shields.io/badge/platform-Windows-3FA7B8)
![license](https://img.shields.io/badge/license-MIT-4C9F70)

**v0.1.0** · [Download the free Windows installer](https://github.com/Learnmore-smart/cairn/releases/latest/download/Cairn-Setup-Windows-x64.exe)
· [cairn.supastack.dev](https://cairn.supastack.dev)

## What it does

- **Memory & process radar** — live RAM/swap meters with a 4-minute history
  chart, per-drive free space, processes grouped by name with summed memory,
  CPU% deltas, and one-click group kill that refuses system-critical
  processes.
- **Disk & dev-bloat finder** — single-pass parallel scan (capped worker
  pool, so the UI stays smooth) rendered as a squarified treemap with
  click-to-drill and a real breadcrumb trail; `node_modules`, `target/`
  (with `Cargo.toml`), `.venv`, `.next`, WSL `*.vhdx` and friends are
  tagged as *rebuildable* — never your real assets. The last scan per
  drive is remembered across restarts.
- **Deny-delete vault** — NTFS ACL locks that persist outside the app:
  Explorer, scripts and WSL all get `Access denied`.
- **Light & dark themes**, tray icon with live RAM tooltip, close-to-tray,
  launch-at-login.

## Free vs Pro

Cairn is open-core. This repository builds the **free** edition — the
Pro features (watchdog, cloud backup, timed unlock) live in a separate
private repository and are not present here in any form.

| | **Free** (this repo) | **Pro** — one-time unlock |
| --- | --- | --- |
| Focus | Find space, lock by hand | Prevent disasters automatically |
| Memory & process radar | ✔ | ✔ |
| Disk tree + dev-cache tags | ✔ | ✔ |
| Deny-delete vault folders | up to **2**, permanent lock / manual unlock | **unlimited** |
| Timed unlock (auto re-lock after 5 min) | — | ✔ |
| Delete-burst kill switch (20+ deletions / 3 s → alert + re-lock) | — | ✔ |
| BYOC one-way cloud backup (Google Drive / OneDrive / S3 / R2 / USB — `copy`, never `sync`) | — | ✔ |
| Orphan-asset radar | — | ✔ |
| Timed growth alerts | — | ✔ |

Free builds show the Pro sections as locked cards with an upgrade link.
The enforcement isn't a flag you can bypass: the free binary contains
no watchdog or backup code at all — those commands don't exist here,
so there's nothing to patch, spoof, or locally enable.

Pro is a **one-time purchase, runs fully local** — no accounts, no
servers on our side. "Cloud backup" means *your own* cloud: you connect
your Google Drive/OneDrive/R2 via `rclone config`, Cairn only ever
**copies** (with replaced files archived under `_Archive/<date>/`), so a
local wipe can never propagate to your remote. That's the difference vs
the official Drive/OneDrive clients, which are two-way and will happily
sync a `rm -rf` into the cloud.

Get it at [cairn.supastack.dev](https://cairn.supastack.dev).

## Download

- Windows installer (free): [releases/latest](https://github.com/Learnmore-smart/cairn/releases/latest)

## Build from source

Requires: [Rust](https://rustup.rs), Node 22+, pnpm (or npm), and the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)
(WebView2 ships with Windows 11).

```sh
pnpm install
pnpm dev:ui        # vite dev server only
pnpm tauri dev     # full desktop app — window + tray
pnpm build         # production build + installers (src-tauri/target/release/bundle)
pnpm test          # vitest + cargo test
pnpm icons         # regenerate src-tauri/icons from the brand SVGs
```

This repo builds the **free** edition only.

> pnpm users: if `@tailwindcss/oxide`'s postinstall is blocked, approve it
> with `pnpm approve-builds` — its native binaries ride in optional
> dependencies.

Pro features need `rclone` on PATH; run `rclone config` once to connect
your cloud remote — the app picks it up automatically.

## License

MIT — see [LICENSE](LICENSE).
