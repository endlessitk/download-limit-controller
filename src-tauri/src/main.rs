#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitRule {
    app_path: String,
    enabled: bool,
    download_limit_kbps: u64,
    label: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineStatus {
    mode: String,
    active: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimiterSettings {
    global_enabled: bool,
    engine_status: EngineStatus,
    rules: Vec<LimitRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkApp {
    app_path: String,
    process_name: String,
    display_name: String,
    connection_count: usize,
    download_bps: u64,
    upload_bps: u64,
    protected: bool,
    pids: Vec<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SocketOwnerRow {
    owning_process: Option<u32>,
    process_name: Option<String>,
    path: Option<String>,
}

#[tauri::command]
fn list_network_apps() -> Result<Vec<NetworkApp>, String> {
    let rows = collect_socket_owners()?;
    let mut grouped: BTreeMap<String, NetworkAppBuilder> = BTreeMap::new();

    for row in rows {
        let Some(pid) = row.owning_process else { continue };
        if pid == 0 {
            continue;
        }

        let process_name = row
            .process_name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| format!("pid-{pid}"));
        let app_path = row
            .path
            .filter(|path| !path.trim().is_empty())
            .unwrap_or_else(|| process_name.clone());
        let key = app_path.to_lowercase();

        let entry = grouped.entry(key).or_insert_with(|| NetworkAppBuilder {
            app_path: app_path.clone(),
            process_name: process_name.clone(),
            display_name: display_name_from_path(&app_path, &process_name),
            connection_count: 0,
            pids: BTreeSet::new(),
        });

        entry.connection_count += 1;
        entry.pids.insert(pid);
    }

    let mut apps: Vec<NetworkApp> = grouped
        .into_values()
        .map(|builder| {
            let pids: Vec<u32> = builder.pids.into_iter().collect();
            NetworkApp {
                protected: is_protected_app(&builder.app_path, &builder.process_name),
                app_path: builder.app_path,
                process_name: builder.process_name,
                display_name: builder.display_name,
                connection_count: builder.connection_count,
                download_bps: 0,
                upload_bps: 0,
                pids,
            }
        })
        .collect();

    apps.sort_by(|a, b| b.connection_count.cmp(&a.connection_count));
    Ok(apps)
}

#[tauri::command]
fn load_settings() -> Result<LimiterSettings, String> {
    load_settings_from_disk()
}

#[tauri::command]
fn set_global_enabled(enabled: bool) -> Result<LimiterSettings, String> {
    let mut settings = load_settings_from_disk()?;
    settings.global_enabled = enabled;
    settings.engine_status = engine_status_for(&settings);
    save_settings_to_disk(&settings)?;
    Ok(settings)
}

#[tauri::command]
fn disable_all_limits() -> Result<LimiterSettings, String> {
    let mut settings = load_settings_from_disk()?;
    settings.global_enabled = false;
    for rule in &mut settings.rules {
        rule.enabled = false;
        rule.updated_at = Some(timestamp());
    }
    settings.engine_status = engine_status_for(&settings);
    save_settings_to_disk(&settings)?;
    Ok(settings)
}

#[tauri::command]
fn upsert_rule(mut rule: LimitRule) -> Result<LimiterSettings, String> {
    if rule.app_path.trim().is_empty() {
        return Err("Rule appPath cannot be empty.".to_string());
    }
    if rule.download_limit_kbps < 32 {
        return Err("Download limit must be at least 32 Kbps.".to_string());
    }

    let mut settings = load_settings_from_disk()?;
    let now = timestamp();
    let existing_created_at = settings
        .rules
        .iter()
        .find(|existing| existing.app_path.eq_ignore_ascii_case(&rule.app_path))
        .and_then(|existing| existing.created_at.clone());

    rule.created_at = existing_created_at.or_else(|| Some(now.clone()));
    rule.updated_at = Some(now);

    settings
        .rules
        .retain(|existing| !existing.app_path.eq_ignore_ascii_case(&rule.app_path));
    settings.rules.insert(0, rule);
    settings.engine_status = engine_status_for(&settings);
    save_settings_to_disk(&settings)?;
    Ok(settings)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_network_apps,
            load_settings,
            set_global_enabled,
            disable_all_limits,
            upsert_rule
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Download Limit Controller");
}

struct NetworkAppBuilder {
    app_path: String,
    process_name: String,
    display_name: String,
    connection_count: usize,
    pids: BTreeSet<u32>,
}

fn collect_socket_owners() -> Result<Vec<SocketOwnerRow>, String> {
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$tcp = Get-NetTCPConnection | Select-Object OwningProcess
$udp = Get-NetUDPEndpoint | Select-Object OwningProcess
$rows = @($tcp) + @($udp) | Where-Object { $_.OwningProcess -gt 0 }
$result = foreach ($row in $rows) {
  $process = Get-Process -Id $row.OwningProcess -ErrorAction SilentlyContinue
  if ($process) {
    [PSCustomObject]@{
      OwningProcess = [int]$row.OwningProcess
      ProcessName = [string]$process.ProcessName
      Path = [string]$process.Path
    }
  }
}
$result | ConvertTo-Json -Depth 3 -Compress
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
        .output()
        .map_err(|error| format!("Unable to start PowerShell process discovery: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "PowerShell process discovery failed.".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() || stdout == "null" {
        return Ok(Vec::new());
    }

    match serde_json::from_str::<Vec<SocketOwnerRow>>(&stdout) {
        Ok(rows) => Ok(rows),
        Err(_) => serde_json::from_str::<SocketOwnerRow>(&stdout)
            .map(|row| vec![row])
            .map_err(|error| format!("Unable to parse process discovery output: {error}")),
    }
}

fn config_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or_else(|| "Unable to locate user config directory.".to_string())?;
    Ok(base.join("DownloadLimitController").join("rules.json"))
}

fn load_settings_from_disk() -> Result<LimiterSettings, String> {
    let path = config_path()?;
    if !path.exists() {
        let settings = default_settings();
        save_settings_to_disk(&settings)?;
        return Ok(settings);
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read limiter settings at {}: {error}", path.display()))?;
    let mut settings: LimiterSettings = serde_json::from_str(&raw)
        .map_err(|error| format!("Unable to parse limiter settings at {}: {error}", path.display()))?;
    settings.engine_status = engine_status_for(&settings);
    Ok(settings)
}

fn save_settings_to_disk(settings: &LimiterSettings) -> Result<(), String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create limiter config directory: {error}"))?;
    }
    let payload = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Unable to serialize limiter settings: {error}"))?;
    fs::write(&path, payload)
        .map_err(|error| format!("Unable to write limiter settings at {}: {error}", path.display()))
}

fn default_settings() -> LimiterSettings {
    let mut settings = LimiterSettings {
        global_enabled: false,
        engine_status: EngineStatus {
            mode: "fail-open".to_string(),
            active: false,
            message: "Limiter is off. No packets are being touched.".to_string(),
        },
        rules: Vec::new(),
    };
    settings.engine_status = engine_status_for(&settings);
    settings
}

fn engine_status_for(settings: &LimiterSettings) -> EngineStatus {
    let any_enabled_rule = settings.rules.iter().any(|rule| rule.enabled);
    if !settings.global_enabled || !any_enabled_rule {
        return EngineStatus {
            mode: "off".to_string(),
            active: false,
            message: "Limiter is off or no enabled rules exist. Network traffic is untouched.".to_string(),
        };
    }

    EngineStatus {
        mode: "driver-unavailable".to_string(),
        active: false,
        message: "Rules are saved, but the WinDivert/WFP throttle bridge is not installed yet. Fail-open mode keeps traffic untouched.".to_string(),
    }
}

fn display_name_from_path(app_path: &str, process_name: &str) -> String {
    let file_name = app_path
        .rsplit(['\\', '/'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(process_name);
    file_name.to_string()
}

fn is_protected_app(app_path: &str, process_name: &str) -> bool {
    let path = app_path.to_lowercase();
    let name = process_name.to_lowercase();
    path.starts_with("c:\\windows\\system32")
        || path.starts_with("c:\\windows\\syswow64")
        || matches!(
            name.as_str(),
            "system" | "idle" | "services" | "lsass" | "wininit" | "winlogon" | "svchost" | "spoolsv"
        )
}

fn timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format!("{seconds}")
}
