import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Check,
  Gauge,
  Layers,
  Minus,
  Plus,
  Power,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Wifi,
  X,
  ZapOff,
} from "lucide-react";
import "./styles.css";

const isTauri = Boolean(window.__TAURI_INTERNALS__);
const isElectron = Boolean(window.netlimiter);

async function invokeCommand(command, payload) {
  if (isElectron) {
    return window.netlimiter.invoke(command, payload);
  }

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
    message: "Browser preview mode. Desktop builds use the local process backend.",
  },
  rules: [],
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
  await new Promise((resolve) => setTimeout(resolve, 140));
  if (command === "list_network_apps") return mockApps;
  if (command === "load_settings") return mockSettings;
  if (command === "set_global_enabled") {
    mockSettings = {
      ...mockSettings,
      globalEnabled: payload.enabled,
      engineStatus: {
        mode: "mock",
        active: false,
        message: payload.enabled ? "Mock rules are saved. No packets are touched." : "All limiting is disabled.",
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

function formatLimit(kbps) {
  const value = Number(kbps) || 0;
  if (value >= 1000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)} Mbps`;
  return `${value} Kbps`;
}

function shortPath(path) {
  const parts = String(path || "").split("\\").filter(Boolean);
  if (parts.length <= 3) return path || "Unknown path";
  return `${parts[0]}\\...\\${parts.slice(-3).join("\\")}`;
}

function ruleFor(settings, appPath) {
  return settings?.rules?.find((rule) => rule.appPath.toLowerCase() === appPath.toLowerCase());
}

function appForRule(apps, rule) {
  return (
    apps.find((app) => app.appPath.toLowerCase() === rule.appPath.toLowerCase()) || {
      appPath: rule.appPath,
      processName: rule.label || rule.appPath.split("\\").pop() || "Saved app",
      displayName: rule.label || rule.appPath.split("\\").pop() || "Saved app",
      connectionCount: 0,
      downloadBps: 0,
      uploadBps: 0,
      protected: false,
      pids: [],
    }
  );
}

function activityScore(app) {
  return (app.downloadBps || 0) + (app.uploadBps || 0) + (app.connectionCount || 0) * 1024;
}

function App() {
  const [apps, setApps] = useState([]);
  const [settings, setSettings] = useState(null);
  const [selectedPath, setSelectedPath] = useState(null);
  const [limit, setLimit] = useState(1500);
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [search, setSearch] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function refresh({ quiet = false } = {}) {
    if (!quiet) setLoading(true);
    setError("");
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
      if (!quiet) setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(() => refresh({ quiet: true }), 4000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!isModalOpen) return undefined;
    function handleKeyDown(event) {
      if (event.key === "Escape") setIsModalOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isModalOpen]);

  const rules = settings?.rules || [];
  const selectedApp = useMemo(
    () => apps.find((app) => app.appPath === selectedPath) || apps[0] || null,
    [apps, selectedPath],
  );
  const selectedRule = selectedApp ? ruleFor(settings, selectedApp.appPath) : null;

  useEffect(() => {
    if (!isModalOpen || !selectedApp) return;
    setLimit(selectedRule?.downloadLimitKbps || 1500);
    setRuleEnabled(selectedRule?.enabled ?? !selectedApp.protected);
    setSaveState("idle");
  }, [isModalOpen, selectedApp?.appPath, selectedRule?.downloadLimitKbps, selectedRule?.enabled]);

  const filteredApps = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matchingApps = needle
      ? apps.filter((app) => {
          const haystack = `${app.displayName} ${app.processName} ${app.appPath}`.toLowerCase();
          return haystack.includes(needle);
        })
      : apps;

    return [...matchingApps].sort((a, b) => {
      const scoreDelta = activityScore(b) - activityScore(a);
      if (scoreDelta !== 0) return scoreDelta;
      const connectionDelta = (b.connectionCount || 0) - (a.connectionCount || 0);
      if (connectionDelta !== 0) return connectionDelta;
      return (a.displayName || a.processName).localeCompare(b.displayName || b.processName);
    });
  }, [apps, search]);

  function openBuilder(appPath) {
    const fallbackPath = appPath || apps[0]?.appPath || null;
    setSelectedPath(fallbackPath);
    setSearch("");
    setIsModalOpen(true);
  }

  async function updateGlobal(enabled) {
    setSettings(await invokeCommand("set_global_enabled", { enabled }));
  }

  async function disableAll() {
    setSettings(await invokeCommand("disable_all_limits"));
  }

  async function saveRule() {
    if (!selectedApp) return;
    const nextLimit = Math.max(32, Number(limit) || 32);
    const nextEnabled = selectedApp.protected ? false : Boolean(ruleEnabled);
    setSaveState("saving");
    try {
      const nextSettings = await invokeCommand("upsert_rule", {
        rule: {
          appPath: selectedApp.appPath,
          enabled: nextEnabled,
          downloadLimitKbps: nextLimit,
          label: selectedApp.displayName || selectedApp.processName,
        },
      });
      setSettings(nextSettings);
      setSaveState("saved");
      setTimeout(() => {
        setIsModalOpen(false);
        setSaveState("idle");
      }, 260);
    } catch (err) {
      setSaveState("idle");
      setError(err?.message || String(err));
    }
  }

  async function toggleRule(rule, enabled) {
    const app = appForRule(apps, rule);
    const nextSettings = await invokeCommand("upsert_rule", {
      rule: {
        ...rule,
        enabled: app.protected ? false : enabled,
        label: rule.label || app.displayName || app.processName,
      },
    });
    setSettings(nextSettings);
  }

  const engine = settings?.engineStatus;
  const activeRules = rules.filter((rule) => rule.enabled).length;

  return (
    <main className="appShell">
      <header className="topbar" aria-label="Application controls">
        <div>
          <p className="kicker">Download Limit Controller</p>
          <h1>Rules</h1>
        </div>
        <div className="topbarActions">
          <button className="secondaryButton" onClick={() => refresh()} disabled={loading}>
            <RefreshCw size={16} /> Refresh
          </button>
          <button className="secondaryButton dangerText" onClick={disableAll} disabled={!settings || rules.length === 0}>
            <ZapOff size={16} /> Disable all
          </button>
          <button
            className={settings?.globalEnabled ? "toggleButton active" : "toggleButton"}
            onClick={() => updateGlobal(!settings?.globalEnabled)}
            disabled={!settings}
            aria-pressed={Boolean(settings?.globalEnabled)}
          >
            <Power size={16} /> {settings?.globalEnabled ? "Master on" : "Master off"}
          </button>
        </div>
      </header>

      <section className="statusStrip" aria-label="Limiter status">
        <div>
          <span className="statusDot" />
          <strong>{activeRules} active</strong>
          <span>{rules.length} saved configs</span>
        </div>
        <p>{engine?.message || "Loading local limiter status..."}</p>
      </section>

      {error && (
        <div className="alert error" role="alert">
          <AlertTriangle size={18} /> {error}
        </div>
      )}

      <section className={rules.length ? "ruleBoard hasRules" : "ruleBoard"} aria-label="Saved limit configurations">
        {rules.length === 0 ? (
          <div className="emptyState">
            <button className="addTile" onClick={() => openBuilder()} aria-label="Add a new limit rule">
              <Plus size={34} />
            </button>
            <h2>No limits yet</h2>
            <p>Click plus to choose a network process and save your first rule.</p>
          </div>
        ) : (
          <>
            <div className="ruleList">
              {rules.map((rule) => {
                const app = appForRule(apps, rule);
                return (
                  <article className="ruleCard" key={rule.appPath}>
                    <div className="ruleIcon" aria-hidden="true">
                      <Layers size={20} />
                    </div>
                    <div className="ruleBody">
                      <div className="ruleTitleRow">
                        <h2>{rule.label || app.displayName || app.processName}</h2>
                        <span className={rule.enabled ? "badge enabled" : "badge"}>{rule.enabled ? "Enabled" : "Paused"}</span>
                      </div>
                      <p>{shortPath(rule.appPath)}</p>
                      <div className="ruleMeta" aria-label="Rule details">
                        <span><Gauge size={15} /> {formatLimit(rule.downloadLimitKbps)}</span>
                        <span><Wifi size={15} /> {formatRate(app.downloadBps)} now</span>
                        <span><SlidersHorizontal size={15} /> {app.connectionCount} connections</span>
                      </div>
                    </div>
                    <div className="ruleActions">
                      <button className="iconButton" onClick={() => toggleRule(rule, !rule.enabled)} aria-label={rule.enabled ? "Pause rule" : "Enable rule"}>
                        {rule.enabled ? <Minus size={17} /> : <Power size={17} />}
                      </button>
                      <button className="secondaryButton" onClick={() => openBuilder(rule.appPath)}>
                        Edit
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            <button className="addTile compact" onClick={() => openBuilder()} aria-label="Add another limit rule">
              <Plus size={28} />
            </button>
          </>
        )}
      </section>

      {isModalOpen && (
        <div className="modalLayer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setIsModalOpen(false)}>
          <section className="builderModal" role="dialog" aria-modal="true" aria-labelledby="builder-title">
            <header className="modalHeader">
              <div>
                <p className="kicker">New configuration</p>
                <h2 id="builder-title">Choose process and limit</h2>
              </div>
              <button className="iconButton" onClick={() => setIsModalOpen(false)} aria-label="Close rule builder">
                <X size={18} />
              </button>
            </header>

            <div className="modalGrid">
              <aside className="processPanel" aria-label="Process list">
                <div className="sectionHeader">
                  <div>
                    <span>Process</span>
                    <strong>{filteredApps.length} apps found · most active first</strong>
                  </div>
                  <button className="iconButton" onClick={() => refresh()} aria-label="Refresh process list">
                    <RefreshCw size={16} />
                  </button>
                </div>
                <label className="searchBox">
                  <Search size={16} />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search app or path" />
                </label>
                <div className="processList">
                  {filteredApps.map((app) => {
                    const isSelected = app.appPath === selectedApp?.appPath;
                    return (
                      <button
                        className={isSelected ? "processRow selected" : "processRow"}
                        key={app.appPath}
                        onClick={() => setSelectedPath(app.appPath)}
                      >
                        <span className="processMark"><Wifi size={16} /></span>
                        <span className="processText">
                          <strong>{app.displayName || app.processName}</strong>
                          <small>{shortPath(app.appPath)}</small>
                        </span>
                        <span className="processStats">
                          <b>{formatRate(app.downloadBps)}</b>
                          <small>{app.connectionCount} conn</small>
                        </span>
                      </button>
                    );
                  })}
                  {filteredApps.length === 0 && <p className="emptyList">No matching processes.</p>}
                </div>
              </aside>

              <section className="settingsPanel" aria-label="Rule settings">
                {selectedApp ? (
                  <>
                    <section className="settingsGroup">
                      <div className="sectionHeader stacked">
                        <span>Process</span>
                        <strong>{selectedApp.displayName || selectedApp.processName}</strong>
                      </div>
                      <p className="pathLine">{selectedApp.appPath}</p>
                      <div className="miniStats">
                        <span>Download <b>{formatRate(selectedApp.downloadBps)}</b></span>
                        <span>Upload <b>{formatRate(selectedApp.uploadBps)}</b></span>
                        <span>PIDs <b>{selectedApp.pids.length}</b></span>
                      </div>
                    </section>

                    <section className="settingsGroup">
                      <div className="sectionHeader stacked">
                        <span>Limit</span>
                        <strong>Download cap</strong>
                      </div>
                      <label className="fieldLabel" htmlFor="download-limit">Limit value</label>
                      <div className="limitInput">
                        <input
                          id="download-limit"
                          type="number"
                          min="32"
                          step="64"
                          value={limit}
                          onChange={(event) => setLimit(event.target.value)}
                        />
                        <span>Kbps</span>
                      </div>
                      <label className="switchRow">
                        <input
                          type="checkbox"
                          checked={ruleEnabled && !selectedApp.protected}
                          disabled={selectedApp.protected}
                          onChange={(event) => setRuleEnabled(event.target.checked)}
                        />
                        <span>Enable this rule after saving</span>
                      </label>
                    </section>

                    <section className="settingsGroup">
                      <div className="sectionHeader stacked">
                        <span>Safety</span>
                        <strong>{selectedApp.protected ? "Protected system app" : "Editable app"}</strong>
                      </div>
                      <div className={selectedApp.protected ? "safetyBox warning" : "safetyBox"}>
                        {selectedApp.protected ? <ShieldAlert size={18} /> : <Check size={18} />}
                        <p>
                          {selectedApp.protected
                            ? "This looks like a Windows system executable. You can inspect it, but enabled rules stay blocked."
                            : "Rules are tied to this executable path, so reopened processes keep the same config."}
                        </p>
                      </div>
                    </section>

                    <section className="settingsGroup mutedGroup">
                      <div className="sectionHeader stacked">
                        <span>Status</span>
                        <strong>{engine?.mode || "loading"}</strong>
                      </div>
                      <p>{engine?.message || "Loading limiter state..."}</p>
                    </section>
                  </>
                ) : (
                  <div className="emptyList">No process selected.</div>
                )}
              </section>
            </div>

            <footer className="modalFooter">
              <button className="secondaryButton" onClick={() => setIsModalOpen(false)}>Cancel</button>
              <button className="primaryButton" onClick={saveRule} disabled={!selectedApp || saveState === "saving" || (selectedApp?.protected && ruleEnabled)}>
                {saveState === "saved" ? <Check size={17} /> : <Plus size={17} />}
                {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved" : "Save configuration"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
