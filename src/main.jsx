import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, Gauge, Network, Power, RefreshCw, ShieldCheck, ZapOff } from "lucide-react";
import "./styles.css";

const isTauri = Boolean(window.__TAURI_INTERNALS__);

async function invokeCommand(command, payload) {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(command, payload);
  }

  return mockInvoke(command, payload);
}

const now = () => new Date().toISOString();

let mockSettings = {
  globalEnabled: false,
  engineStatus: {
    mode: "mock",
    active: false,
    message: "Browser preview mode. Run the Tauri app as administrator to control Windows traffic.",
  },
  rules: [
    {
      appPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      enabled: false,
      downloadLimitKbps: 2500,
      label: "Chrome",
      createdAt: now(),
      updatedAt: now(),
    },
  ],
};

const mockApps = [
  {
    appPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    processName: "chrome.exe",
    displayName: "Google Chrome",
    connectionCount: 28,
    downloadBps: 850000,
    uploadBps: 64000,
    protected: false,
    pids: [1132, 4208, 8420],
  },
  {
    appPath: "C:\\Program Files (x86)\\Steam\\steam.exe",
    processName: "steam.exe",
    displayName: "Steam",
    connectionCount: 12,
    downloadBps: 1275000,
    uploadBps: 42000,
    protected: false,
    pids: [7332],
  },
  {
    appPath: "C:\\Windows\\System32\\svchost.exe",
    processName: "svchost.exe",
    displayName: "Windows Service Host",
    connectionCount: 9,
    downloadBps: 12000,
    uploadBps: 9000,
    protected: true,
    pids: [948, 1212],
  },
];

async function mockInvoke(command, payload = {}) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (command === "list_network_apps") return mockApps;
  if (command === "load_settings") return mockSettings;
  if (command === "set_global_enabled") {
    mockSettings = {
      ...mockSettings,
      globalEnabled: payload.enabled,
      engineStatus: {
        mode: "mock",
        active: false,
        message: payload.enabled
          ? "Mock mode accepted the toggle, but no packets are touched."
          : "All limiting is disabled.",
      },
    };
    return mockSettings;
  }
  if (command === "disable_all_limits") {
    mockSettings = {
      ...mockSettings,
      globalEnabled: false,
      rules: mockSettings.rules.map((rule) => ({ ...rule, enabled: false, updatedAt: now() })),
      engineStatus: { mode: "mock", active: false, message: "All mock limits disabled." },
    };
    return mockSettings;
  }
  if (command === "upsert_rule") {
    const incoming = payload.rule;
    const existing = mockSettings.rules.find((rule) => rule.appPath === incoming.appPath);
    const nextRule = {
      ...existing,
      ...incoming,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
    };
    mockSettings = {
      ...mockSettings,
      rules: [nextRule, ...mockSettings.rules.filter((rule) => rule.appPath !== incoming.appPath)],
    };
    return mockSettings;
  }
  throw new Error(`Unknown mock command: ${command}`);
}

function formatRate(bytesPerSecond) {
  if (!bytesPerSecond) return "0 KB/s";
  const kb = bytesPerSecond / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB/s`;
  return `${(kb / 1024).toFixed(1)} MB/s`;
}

function shortPath(path) {
  const parts = path.split("\\");
  if (parts.length <= 3) return path;
  return `${parts[0]}\\...\\${parts.slice(-3).join("\\")}`;
}

function ruleFor(settings, appPath) {
  return settings.rules.find((rule) => rule.appPath.toLowerCase() === appPath.toLowerCase());
}

function App() {
  const [apps, setApps] = useState([]);
  const [settings, setSettings] = useState(null);
  const [selectedPath, setSelectedPath] = useState(null);
  const [limit, setLimit] = useState(1500);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setError("");
    setLoading(true);
    try {
      const [nextApps, nextSettings] = await Promise.all([
        invokeCommand("list_network_apps"),
        invokeCommand("load_settings"),
      ]);
      setApps(nextApps);
      setSettings(nextSettings);
      if (!selectedPath && nextApps[0]) setSelectedPath(nextApps[0].appPath);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  const selectedApp = useMemo(
    () => apps.find((app) => app.appPath === selectedPath) || apps[0],
    [apps, selectedPath],
  );
  const selectedRule = settings && selectedApp ? ruleFor(settings, selectedApp.appPath) : null;

  useEffect(() => {
    if (selectedRule?.downloadLimitKbps) setLimit(selectedRule.downloadLimitKbps);
  }, [selectedRule?.downloadLimitKbps, selectedPath]);

  async function updateGlobal(enabled) {
    setSettings(await invokeCommand("set_global_enabled", { enabled }));
  }

  async function disableAll() {
    setSettings(await invokeCommand("disable_all_limits"));
  }

  async function saveRule(enabled = true) {
    if (!selectedApp) return;
    const nextLimit = Math.max(32, Number(limit) || 32);
    setSettings(
      await invokeCommand("upsert_rule", {
        rule: {
          appPath: selectedApp.appPath,
          enabled,
          downloadLimitKbps: nextLimit,
          label: selectedApp.displayName || selectedApp.processName,
        },
      }),
    );
  }

  const engine = settings?.engineStatus;

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Windows Utility</p>
          <h1>Download Limit Controller</h1>
          <p className="lede">
            Group network activity by executable path, then apply safe per-app download caps with master toggles and fail-open protection.
          </p>
        </div>
        <div className="heroActions">
          <button className="ghost" onClick={refresh} disabled={loading}>
            <RefreshCw size={16} /> Refresh
          </button>
          <button className="danger" onClick={disableAll} disabled={!settings}>
            <ZapOff size={16} /> Disable all
          </button>
          <button
            className={settings?.globalEnabled ? "power on" : "power"}
            onClick={() => updateGlobal(!settings?.globalEnabled)}
            disabled={!settings}
          >
            <Power size={17} /> {settings?.globalEnabled ? "Limiter on" : "Limiter off"}
          </button>
        </div>
      </section>

      {error && <div className="notice error"><AlertTriangle size={18} /> {error}</div>}
      {engine && (
        <div className={engine.active ? "notice good" : "notice warn"}>
          <ShieldCheck size={18} />
          <span>{engine.message}</span>
        </div>
      )}

      <section className="grid">
        <aside className="panel listPanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Grouped apps</p>
              <h2>Network processes</h2>
            </div>
            <span className="pill">{apps.length} apps</span>
          </div>
          <div className="appList">
            {apps.map((app) => {
              const rule = settings ? ruleFor(settings, app.appPath) : null;
              return (
                <button
                  className={app.appPath === selectedApp?.appPath ? "appCard selected" : "appCard"}
                  key={app.appPath}
                  onClick={() => setSelectedPath(app.appPath)}
                >
                  <div className="appIcon"><Network size={18} /></div>
                  <div className="appMain">
                    <strong>{app.displayName || app.processName}</strong>
                    <span>{shortPath(app.appPath)}</span>
                    <small>{app.connectionCount} connections · {app.pids.length} process ids</small>
                  </div>
                  <div className="appMeta">
                    {app.protected && <span className="tag protected">protected</span>}
                    {rule?.enabled && <span className="tag active">limited</span>}
                    <b>{formatRate(app.downloadBps)}</b>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="panel detailPanel">
          {selectedApp ? (
            <>
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">Selected app</p>
                  <h2>{selectedApp.displayName || selectedApp.processName}</h2>
                </div>
                {selectedApp.protected ? <span className="pill dangerPill">Protected</span> : <span className="pill">Editable</span>}
              </div>

              <dl className="metrics">
                <div><dt>Download</dt><dd>{formatRate(selectedApp.downloadBps)}</dd></div>
                <div><dt>Upload</dt><dd>{formatRate(selectedApp.uploadBps)}</dd></div>
                <div><dt>Connections</dt><dd>{selectedApp.connectionCount}</dd></div>
                <div><dt>Rule</dt><dd>{selectedRule?.enabled ? `${selectedRule.downloadLimitKbps} Kbps` : "Off"}</dd></div>
              </dl>

              <div className="pathBox">{selectedApp.appPath}</div>

              <label className="limitBox">
                <span>Download limit per app group</span>
                <div>
                  <Gauge size={18} />
                  <input
                    type="number"
                    min="32"
                    step="64"
                    value={limit}
                    onChange={(event) => setLimit(event.target.value)}
                  />
                  <em>Kbps</em>
                </div>
              </label>

              {selectedApp.protected && (
                <div className="notice warn compact">
                  <AlertTriangle size={16} /> This looks like a system-critical executable. Keep disabled unless you intentionally override it later.
                </div>
              )}

              <div className="ruleActions">
                <button className="primary" onClick={() => saveRule(true)} disabled={selectedApp.protected}>
                  Save and enable rule
                </button>
                <button className="ghost" onClick={() => saveRule(false)}>
                  Save disabled
                </button>
              </div>
            </>
          ) : (
            <div className="empty">No active network apps found yet.</div>
          )}
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
