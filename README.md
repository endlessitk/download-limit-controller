# Download Limit Controller

Standalone Windows utility for grouping active network processes by executable path and managing per-app download limit rules.

## Commands

Run from the repository root:

```powershell
pnpm dev
pnpm build
pnpm electron:dev
pnpm tauri:dev
pnpm tauri:build
pnpm release
```

The Vite preview can run without a desktop shell and uses mock data. Real process discovery is exposed through the desktop backend.

## Local Windows Installer Release

This project builds an unsigned NSIS `setup.exe` installer through Electron Builder:

```powershell
pnpm install
pnpm release:clean
pnpm build
pnpm release
```

Expected installer output:

```text
release/Download Limit Controller Setup 0.1.0.exe
```

Release prerequisites on Windows:

- Node.js and pnpm
- Electron Builder downloads/caches its NSIS tooling automatically

The Tauri release path is still configured as `pnpm release:tauri`, but this machine blocks Rust build-script executables through Windows Application Control (`os error 4551`). Use the Electron Builder release path for local installer builds on this machine.

The first release is unsigned, so Windows SmartScreen may warn on install.

## Safety Model

- Rules are stored in the user config directory under `DownloadLimitController/rules.json`.
- Global limiting starts disabled.
- `Disable all` turns off the global switch and every saved per-app rule.
- System-critical Windows executables are marked protected in the UI.
- The current backend is fail-open if the WinDivert/WFP packet bridge is not installed, so saved rules do not touch packets until the driver adapter is implemented and available.

## Current Driver Boundary

This app implements the desktop shell, grouped process discovery, persistent rule model, and safety toggles. The packet throttling adapter is intentionally guarded behind `driver-unavailable` status until a signed WinDivert/WFP bridge is added.
