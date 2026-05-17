# Download Limit Controller

Standalone Windows utility for grouping active network processes by executable path and managing per-app download limit rules.

## Commands

Run from the repository root:

```powershell
pnpm dev
pnpm build
pnpm tauri:dev
pnpm tauri:build
```

The Vite preview can run without Tauri and uses mock data. Real process discovery is exposed through the Tauri backend.

## Safety Model

- Rules are stored in the user config directory under `DownloadLimitController/rules.json`.
- Global limiting starts disabled.
- `Disable all` turns off the global switch and every saved per-app rule.
- System-critical Windows executables are marked protected in the UI.
- The current backend is fail-open if the WinDivert/WFP packet bridge is not installed, so saved rules do not touch packets until the driver adapter is implemented and available.

## Current Driver Boundary

This app implements the desktop shell, grouped process discovery, persistent rule model, and safety toggles. The packet throttling adapter is intentionally guarded behind `driver-unavailable` status until a signed WinDivert/WFP bridge is added.
