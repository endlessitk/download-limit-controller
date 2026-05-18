const { app, BrowserWindow, ipcMain } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function now() {
  return new Date().toISOString();
}

function defaultSettings() {
  const settings = {
    globalEnabled: false,
    engineStatus: {
      mode: "off",
      active: false,
      message: "Limiter is off or no enabled rules exist. Network traffic is untouched.",
    },
    rules: [],
  };
  settings.engineStatus = engineStatusFor(settings);
  return settings;
}

function settingsPath() {
  return path.join(app.getPath("userData"), "rules.json");
}

function loadSettings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) {
    const settings = defaultSettings();
    saveSettings(settings);
    return settings;
  }

  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  settings.engineStatus = engineStatusFor(settings);
  return settings;
}

function saveSettings(settings) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

function engineStatusFor(settings) {
  const anyEnabledRule = settings.rules.some((rule) => rule.enabled);
  if (!settings.globalEnabled || !anyEnabledRule) {
    return {
      mode: "off",
      active: false,
      message: "Limiter is off or no enabled rules exist. Network traffic is untouched.",
    };
  }

  return {
    mode: "driver-unavailable",
    active: false,
    message: "Rules are saved, but the WinDivert/WFP throttle bridge is not installed yet. Fail-open mode keeps traffic untouched.",
  };
}

function isProtectedApp(appPath, processName) {
  const lowerPath = String(appPath || "").toLowerCase();
  const lowerName = String(processName || "").toLowerCase();
  return (
    lowerPath.startsWith("c:\\windows\\system32") ||
    lowerPath.startsWith("c:\\windows\\syswow64") ||
    ["system", "idle", "services", "lsass", "wininit", "winlogon", "svchost", "spoolsv"].includes(lowerName)
  );
}

function displayNameFromPath(appPath, processName) {
  const fileName = String(appPath || "").split(/[\\/]/).filter(Boolean).pop();
  return fileName || processName || "Unknown app";
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function listNetworkApps() {
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$tcp = Get-NetTCPConnection | Select-Object OwningProcess
$udp = Get-NetUDPEndpoint | Select-Object OwningProcess
$rows = @($tcp) + @($udp) | Where-Object { $_.OwningProcess -gt 0 }
$result = foreach ($row in $rows) {
  $process = Get-Process -Id $row.OwningProcess -ErrorAction SilentlyContinue
  if ($process) {
    [PSCustomObject]@{
      owningProcess = [int]$row.OwningProcess
      processName = [string]$process.ProcessName
      appPath = [string]$process.Path
    }
  }
}
$result | ConvertTo-Json -Depth 3 -Compress
`;

  const raw = await runPowerShell(script);
  if (!raw || raw === "null") return [];
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const grouped = new Map();

  for (const row of rows) {
    const pid = Number(row.owningProcess);
    if (!pid) continue;
    const processName = row.processName || `pid-${pid}`;
    const appPath = row.appPath || processName;
    const key = appPath.toLowerCase();
    if (!grouped.has(key)) {
      grouped.set(key, {
        appPath,
        processName,
        displayName: displayNameFromPath(appPath, processName),
        connectionCount: 0,
        downloadBps: 0,
        uploadBps: 0,
        protected: isProtectedApp(appPath, processName),
        pids: new Set(),
      });
    }
    const appInfo = grouped.get(key);
    appInfo.connectionCount += 1;
    appInfo.pids.add(pid);
  }

  return Array.from(grouped.values())
    .map((entry) => ({ ...entry, pids: Array.from(entry.pids).sort((a, b) => a - b) }))
    .sort((a, b) => b.connectionCount - a.connectionCount);
}

function setGlobalEnabled(enabled) {
  const settings = loadSettings();
  settings.globalEnabled = Boolean(enabled);
  settings.engineStatus = engineStatusFor(settings);
  saveSettings(settings);
  return settings;
}

function disableAllLimits() {
  const settings = loadSettings();
  settings.globalEnabled = false;
  settings.rules = settings.rules.map((rule) => ({ ...rule, enabled: false, updatedAt: now() }));
  settings.engineStatus = engineStatusFor(settings);
  saveSettings(settings);
  return settings;
}

function upsertRule(rule) {
  if (!rule?.appPath?.trim()) throw new Error("Rule appPath cannot be empty.");
  const limit = Number(rule.downloadLimitKbps);
  if (!Number.isFinite(limit) || limit < 32) throw new Error("Download limit must be at least 32 Kbps.");

  const settings = loadSettings();
  const existing = settings.rules.find((item) => item.appPath.toLowerCase() === rule.appPath.toLowerCase());
  const nextRule = {
    ...existing,
    ...rule,
    downloadLimitKbps: Math.round(limit),
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
  };
  settings.rules = [nextRule, ...settings.rules.filter((item) => item.appPath.toLowerCase() !== rule.appPath.toLowerCase())];
  settings.engineStatus = engineStatusFor(settings);
  saveSettings(settings);
  return settings;
}

async function handleCommand(command, payload = {}) {
  if (command === "list_network_apps") return listNetworkApps();
  if (command === "load_settings") return loadSettings();
  if (command === "set_global_enabled") return setGlobalEnabled(payload.enabled);
  if (command === "disable_all_limits") return disableAllLimits();
  if (command === "upsert_rule") return upsertRule(payload.rule);
  throw new Error(`Unknown command: ${command}`);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Download Limit Controller",
    icon: path.join(__dirname, "..", "src-tauri", "icons", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

ipcMain.handle("netlimiter:invoke", async (_event, { command, payload }) => handleCommand(command, payload));

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
