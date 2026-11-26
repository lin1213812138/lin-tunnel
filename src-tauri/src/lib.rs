use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 用 Job Object 绑定子进程：本进程无论正常退出还是被强杀，
/// Windows 都会在关闭 job 句柄时杀掉 cloudflared，避免留下孤儿隧道。
#[cfg(windows)]
mod job {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut core::ffi::c_void, name: *const u16) -> isize;
        fn SetInformationJobObject(job: isize, class: u32, info: *mut core::ffi::c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
    }

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operations: u64,
        write_operations: u64,
        other_operations: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimit {
        per_process_user_time: i64,
        per_job_user_time: i64,
        limit_flags: u32,
        minimum_working_set: usize,
        maximum_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    pub fn bind_child(child: &std::process::Child) {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job == 0 {
                #[cfg(debug_assertions)]
                eprintln!("JOB create failed");
                return;
            }
            let mut info = ExtendedLimit::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &mut info as *mut _ as *mut core::ffi::c_void,
                size_of::<ExtendedLimit>() as u32,
            );
            #[cfg(debug_assertions)]
            eprintln!(
                "JOB handle={job} set={ok} size={} err={}",
                size_of::<ExtendedLimit>(),
                std::io::Error::last_os_error()
            );
            if ok != 0 {
                // 句柄故意不关闭：本进程结束时由系统关闭，触发 kill-on-close。
                let assigned = AssignProcessToJobObject(job, child.as_raw_handle() as isize);
                #[cfg(debug_assertions)]
                eprintln!("JOB assign={assigned} err={}", std::io::Error::last_os_error());
                let _ = assigned;
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelView {
    pub id: String,
    pub name: String,
    pub port: u16,
    pub target: String,
    pub status: String,
    pub paused: bool,
    /// quick = Cloudflare 随机域名；named = 自带域名（Named Tunnel）
    pub mode: String,
    pub url: Option<String>,
    pub error: Option<String>,
    pub pid: Option<u32>,
    pub created_at: u64,
}

pub struct Tunnel {
    pub view: Arc<Mutex<TunnelView>>,
    pub logs: Arc<Mutex<Vec<String>>>,
    pub child: Mutex<Option<Child>>,
    /// 每次启动/停止递增；守护线程据此判断自己是否过期。
    pub generation: Arc<AtomicU64>,
    /// cloudflared 的传输协议（None=自动），重启时沿用。
    pub protocol: Mutex<Option<String>>,
    /// 自带域名（Named Tunnel）用的账号 token，None 表示用 Cloudflare 随机域名
    pub token: Mutex<Option<String>>,
    /// 自带域名，例如 tunnel.example.com
    pub domain: Mutex<Option<String>>,
}

pub struct AppState {
    pub tunnels: Mutex<HashMap<String, Arc<Tunnel>>>,
    pub cloudflared: PathBuf,
}

#[derive(Serialize)]
pub struct CloudflaredInfo {
    pub path: String,
    pub version: String,
}

const MAX_LOGS: usize = 500;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn detect_origin(port: u16) -> (String, bool) {
    let probe = |host: &str| -> bool {
        let addr = format!("{host}:{port}");
        match addr.to_socket_addrs() {
            Ok(mut iter) => match iter.next() {
                Some(sock) => TcpStream::connect_timeout(&sock, Duration::from_millis(500)).is_ok(),
                None => false,
            },
            Err(_) => false,
        }
    };
    if probe("127.0.0.1") {
        (format!("http://127.0.0.1:{port}"), true)
    } else if probe("[::1]") {
        (format!("http://localhost:{port}"), true)
    } else {
        (format!("http://127.0.0.1:{port}"), false)
    }
}

fn push_log(logs: &Arc<Mutex<Vec<String>>>, line: &str) {
    if let Ok(mut guard) = logs.lock() {
        guard.push(line.to_string());
        if guard.len() > MAX_LOGS {
            let extra = guard.len() - MAX_LOGS;
            guard.drain(0..extra);
        }
    }
}

fn extract_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"' || c == '\'')
        .unwrap_or(rest.len());
    let candidate = rest[..end].trim_end_matches(|c: char| c == '.' || c == ',');
    let host = candidate
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or("");
    // 只认真实的临时隧道地址 https://<随机词>.trycloudflare.com；
    // 日志里出现的 api.trycloudflare.com 之类接口域名必须排除。
    let label = host.strip_suffix(".trycloudflare.com")?;
    if label.is_empty() || label.contains('.') || label == "api" || label == "www" {
        return None;
    }
    Some(format!("https://{host}"))
}

fn spawn_reader<R: Read + Send + 'static>(
    reader: R,
    logs: Arc<Mutex<Vec<String>>>,
    view: Arc<Mutex<TunnelView>>,
) {
    std::thread::spawn(move || {
        let mut buf = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match buf.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            let text = line.trim_end_matches(['\r', '\n']).to_string();
            if text.is_empty() {
                continue;
            }
            push_log(&logs, &text);
            if let Some(url) = extract_url(&text) {
                if let Ok(mut v) = view.lock() {
                    if v.url.is_none() {
                        v.url = Some(url);
                        v.status = "running".into();
                        v.error = None;
                    }
                }
            }
        }
    });
}

fn find_cloudflared(app: &AppHandle) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("bin").join("cloudflared.exe"));
        candidates.push(dir.join("cloudflared.exe"));
        candidates.push(dir.join("resources").join("cloudflared.exe"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("bin").join("cloudflared.exe"));
            candidates.push(parent.join("cloudflared.exe"));
        }
    }
    candidates.push(PathBuf::from("../bin/cloudflared.exe"));
    candidates.push(PathBuf::from("bin/cloudflared.exe"));
    candidates
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from("cloudflared"))
}

#[tauri::command]
fn list_tunnels(state: State<'_, AppState>) -> Vec<TunnelView> {
    let map = match state.tunnels.lock() {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    let mut list: Vec<TunnelView> = map
        .values()
        .filter_map(|tunnel| tunnel.view.lock().ok().map(|view| view.clone()))
        .collect();
    list.sort_by_key(|view| view.created_at);
    list
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn spawn_cloudflared(
    exe: &std::path::Path,
    port: u16,
    protocol: Option<&str>,
    token: Option<&str>,
) -> Result<(Child, String, bool), String> {
    let (target, reachable) = detect_origin(port);
    let exe_display = exe.display().to_string();
    let mut cmd = Command::new(exe);
    match token {
        // 自带域名：用账号里的 tunnel token 跑，回源配置由 Cloudflare 端决定。
        Some(token) => {
            cmd.arg("tunnel")
                .arg("--no-autoupdate")
                .arg("run")
                .arg("--token")
                .arg(token);
        }
        None => {
            cmd.arg("tunnel")
                .arg("--no-autoupdate")
                .arg("--url")
                .arg(&target)
                .arg("--http-host-header")
                .arg("localhost");
        }
    }
    if let Some(proto) = protocol {
        if proto == "quic" || proto == "http2" {
            cmd.arg("--protocol").arg(proto);
        }
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = cmd
        .spawn()
        .map_err(|err| format!("启动 cloudflared 失败（{exe_display}）：{err}"))?;
    #[cfg(windows)]
    job::bind_child(&child);
    Ok((child, target, reachable))
}

/// 启动（或重新启动）cloudflared 进程并把日志/状态线程接上。
/// 调用前必须确保旧进程已由 kill_child 清理掉。
fn start_child(exe: &std::path::Path, tunnel: &Arc<Tunnel>) -> Result<(), String> {
    let port = tunnel
        .view
        .lock()
        .map_err(|_| "状态锁异常".to_string())?
        .port;
    let protocol = tunnel
        .protocol
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    let token = tunnel.token.lock().ok().and_then(|guard| guard.clone());
    let domain = tunnel.domain.lock().ok().and_then(|guard| guard.clone());
    let (mut child, target, reachable) =
        spawn_cloudflared(exe, port, protocol.as_deref(), token.as_deref())?;
    let pid = child.id();
    // 每次启动递增代号，上一代的守护线程看到代号变化后自行退出。
    let gen = tunnel.generation.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut view = tunnel.view.lock().map_err(|_| "状态锁异常".to_string())?;
        view.target = target.clone();
        view.paused = false;
        view.pid = Some(pid);
        if token.is_some() {
            let host = domain
                .as_deref()
                .map(|d| {
                    d.trim()
                        .trim_start_matches("https://")
                        .trim_end_matches('/')
                        .to_string()
                })
                .filter(|d| !d.is_empty());
            view.mode = "named".into();
            view.status = "running".into();
            view.url = host.clone().map(|h| format!("https://{h}"));
            view.error = match (reachable, host) {
                (true, Some(_)) => None,
                (false, Some(_)) => Some(format!(
                    "本机 {port} 端口当前没有监听；请确认 Cloudflare 端回源地址与端口一致"
                )),
                (_, None) => Some("自带域名模式缺少域名，请在「修改」里填写".into()),
            };
        } else {
            view.mode = "quick".into();
            view.status = "starting".into();
            view.url = None;
            view.error = if reachable {
                None
            } else {
                Some(format!("本机 {port} 端口当前没有监听，服务启动后需重启隧道"))
            };
        }
    }
    if token.is_some() {
        push_log(
            &tunnel.logs,
            &format!("$ {} tunnel run --token ***（自带域名）", exe.display()),
        );
    } else {
        push_log(
            &tunnel.logs,
            &format!("$ {} tunnel --url {target}", exe.display()),
        );
    }

    if let Some(stdout) = child.stdout.take() {
        spawn_reader(stdout, tunnel.logs.clone(), tunnel.view.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_reader(stderr, tunnel.logs.clone(), tunnel.view.clone());
    }
    if let Ok(mut guard) = tunnel.child.lock() {
        *guard = Some(child);
    }

    // 30 秒没拿到公网地址就标记失败，避免界面一直转圈。
    {
        let view = tunnel.view.clone();
        let gen_ref = tunnel.generation.clone();
        std::thread::spawn(move || {
            for _ in 0..60 {
                std::thread::sleep(Duration::from_millis(500));
                if gen_ref.load(Ordering::SeqCst) != gen {
                    return;
                }
                let guard = match view.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if guard.status != "starting" {
                    return;
                }
            }
            if gen_ref.load(Ordering::SeqCst) != gen {
                return;
            }
            if let Ok(mut guard) = view.lock() {
                if guard.status == "starting" && !guard.paused {
                    guard.status = "error".into();
                    guard.error = Some("30 秒内未获取到公网地址，请查看日志".into());
                }
            }
        });
    }

    // 进程退出的守护线程：把状态同步为 stopped。
    {
        let tunnel_ref = tunnel.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(800));
            if tunnel_ref.generation.load(Ordering::SeqCst) != gen {
                return;
            }
            let exited = {
                let mut guard = match tunnel_ref.child.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                match guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => Some(status.code()),
                        Ok(None) => None,
                        Err(_) => Some(None),
                    },
                    None => Some(None),
                }
            };
            if let Some(code) = exited {
                let hint = tunnel_ref
                    .logs
                    .lock()
                    .ok()
                    .and_then(|logs| {
                        logs.iter()
                            .rev()
                            .find(|l| l.contains("ERR") || l.contains("failed") || l.contains("429"))
                            .cloned()
                    });
                if let Ok(mut v) = tunnel_ref.view.lock() {
                    if v.status != "error" {
                        v.status = "stopped".into();
                    }
                    v.paused = false;
                    if v.url.is_none() && v.error.is_none() {
                        let base = format!(
                            "cloudflared 已退出（{}）",
                            code.map(|c| format!("code {c}"))
                                .unwrap_or_else(|| "无退出码".into())
                        );
                        v.error = Some(match hint {
                            Some(line) => format!(
                                "{base}：{}",
                                line.chars().take(160).collect::<String>()
                            ),
                            None => base,
                        });
                    }
                    v.pid = None;
                }
                return;
            }
        });
    }

    Ok(())
}

fn kill_child(tunnel: &Arc<Tunnel>) {
    // 代号 +1 让当前守护线程失效，避免旧进程的退出回调覆盖新状态。
    tunnel.generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = tunnel.child.lock() {
        if let Some(mut child) = guard.take() {
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

fn launch_tunnel(
    exe: &std::path::Path,
    name: Option<String>,
    port: u16,
    protocol: Option<String>,
    token: Option<String>,
    domain: Option<String>,
) -> Result<Arc<Tunnel>, String> {
    let id = format!("t{}-{}", now_secs(), NEXT_ID.fetch_add(1, Ordering::SeqCst));
    let named = token.is_some();
    let view = Arc::new(Mutex::new(TunnelView {
        id: id.clone(),
        name: name.unwrap_or_else(|| format!("端口 {port}")),
        port,
        target: format!("http://127.0.0.1:{port}"),
        status: "starting".into(),
        paused: false,
        mode: if named { "named".into() } else { "quick".into() },
        url: None,
        error: None,
        pid: None,
        created_at: now_secs(),
    }));
    let tunnel = Arc::new(Tunnel {
        view,
        logs: Arc::new(Mutex::new(Vec::new())),
        child: Mutex::new(None),
        generation: Arc::new(AtomicU64::new(0)),
        protocol: Mutex::new(protocol),
        token: Mutex::new(token),
        domain: Mutex::new(domain),
    });
    start_child(exe, &tunnel)?;
    Ok(tunnel)
}

fn snapshot(tunnel: &Arc<Tunnel>) -> Result<TunnelView, String> {
    tunnel
        .view
        .lock()
        .map(|view| view.clone())
        .map_err(|_| "状态锁异常".to_string())
}

fn find_tunnel(state: &AppState, id: &str) -> Result<Arc<Tunnel>, String> {
    let map = state
        .tunnels
        .lock()
        .map_err(|_| "隧道表锁异常".to_string())?;
    map.get(id).cloned().ok_or_else(|| "隧道不存在".to_string())
}

fn restart_inner(exe: &std::path::Path, tunnel: &Arc<Tunnel>) -> Result<TunnelView, String> {
    kill_child(tunnel);
    {
        let mut view = tunnel.view.lock().map_err(|_| "状态锁异常".to_string())?;
        view.status = "starting".into();
        view.url = None;
        view.error = None;
        view.paused = false;
        view.pid = None;
    }
    push_log(&tunnel.logs, "—— 重新启动 ——");
    start_child(exe, tunnel)?;
    snapshot(tunnel)
}

#[tauri::command]
fn start_tunnel(
    app: AppHandle,
    state: State<'_, AppState>,
    name: Option<String>,
    port: u16,
    protocol: Option<String>,
    token: Option<String>,
    domain: Option<String>,
) -> Result<TunnelView, String> {
    let token = token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let domain = domain
        .map(|d| {
            d.trim()
                .trim_start_matches("https://")
                .trim_end_matches('/')
                .to_string()
        })
        .filter(|d| !d.is_empty());
    let tunnel = launch_tunnel(&state.cloudflared, name, port, protocol, token, domain)?;
    let snapshot = tunnel
        .view
        .lock()
        .map_err(|_| "状态锁异常".to_string())?
        .clone();
    state
        .tunnels
        .lock()
        .map_err(|_| "隧道表锁异常".to_string())?
        .insert(snapshot.id.clone(), tunnel);
    save_store(&app, state.inner());
    Ok(snapshot)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SavedTunnel {
    name: String,
    port: u16,
    mode: String,
    domain: Option<String>,
    token: Option<String>,
    protocol: Option<String>,
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("tunnels.json"))
}

/// 把当前隧道清单落盘：应用重启后还能恢复列表、端口与自带域名配置。
fn save_store(app: &AppHandle, state: &AppState) {
    let path = match store_path(app) {
        Some(path) => path,
        None => return,
    };
    let list: Vec<SavedTunnel> = match state.tunnels.lock() {
        Ok(map) => map
            .values()
            .filter_map(|tunnel| {
                let view = tunnel.view.lock().ok()?.clone();
                Some(SavedTunnel {
                    name: view.name,
                    port: view.port,
                    mode: view.mode,
                    domain: tunnel.domain.lock().ok().and_then(|d| d.clone()),
                    token: tunnel.token.lock().ok().and_then(|t| t.clone()),
                    protocol: tunnel.protocol.lock().ok().and_then(|p| p.clone()),
                })
            })
            .collect(),
        Err(_) => return,
    };
    if let Ok(text) = serde_json::to_string_pretty(&list) {
        let _ = std::fs::write(path, text);
    }
}

fn load_store(app: &AppHandle) -> Vec<SavedTunnel> {
    let path = match store_path(app) {
        Some(path) => path,
        None => return Vec::new(),
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<SavedTunnel>>(&text).ok())
        .unwrap_or_default()
}

/// 启动时把上次的隧道列表恢复出来（只恢复条目，不自动重连公网）。
#[tauri::command]
fn restore_tunnels(app: AppHandle, state: State<'_, AppState>) -> Vec<TunnelView> {
    let already = state
        .tunnels
        .lock()
        .map(|map| !map.is_empty())
        .unwrap_or(true);
    if already {
        return list_tunnels(state);
    }
    let saved = load_store(&app);
    if saved.is_empty() {
        return list_tunnels(state);
    }
    {
        let mut map = match state.tunnels.lock() {
            Ok(map) => map,
            Err(_) => return Vec::new(),
        };
        for item in saved {
            let id = format!("t{}-{}", now_secs(), NEXT_ID.fetch_add(1, Ordering::SeqCst));
            let named = item.token.is_some();
            let url = if named {
                item.domain
                    .as_deref()
                    .map(|d| format!("https://{d}"))
            } else {
                None
            };
            let tunnel = Arc::new(Tunnel {
                view: Arc::new(Mutex::new(TunnelView {
                    id: id.clone(),
                    name: item.name,
                    port: item.port,
                    target: format!("http://127.0.0.1:{}", item.port),
                    status: "stopped".into(),
                    paused: false,
                    mode: if named { "named".into() } else { "quick".into() },
                    url,
                    error: None,
                    pid: None,
                    created_at: now_secs(),
                })),
                logs: Arc::new(Mutex::new(vec![
                    "已从上次会话恢复；点「启动」重新建立隧道".to_string()
                ])),
                child: Mutex::new(None),
                generation: Arc::new(AtomicU64::new(0)),
                protocol: Mutex::new(item.protocol),
                token: Mutex::new(item.token),
                domain: Mutex::new(item.domain),
            });
            map.insert(id, tunnel);
        }
    }
    list_tunnels(state)
}

/// 无界面自检：`lin-tunnel.exe --smoke 8080`
/// 真实启动 cloudflared、等待公网地址、打印日志后退出，用于回归验证。
pub fn smoke(port: u16) -> i32 {
    let candidates = [
        PathBuf::from("../bin/cloudflared.exe"),
        PathBuf::from("bin/cloudflared.exe"),
        PathBuf::from("cloudflared.exe"),
    ];
    let exe = match candidates.iter().find(|path| path.exists()) {
        Some(path) => path.clone(),
        None => {
            eprintln!("SMOKE_FAIL 找不到 cloudflared.exe");
            return 2;
        }
    };
    println!("SMOKE cloudflared={}", exe.display());
    let tunnel = match launch_tunnel(&exe, Some("smoke".into()), port, None, None, None) {
        Ok(tunnel) => tunnel,
        Err(err) => {
            eprintln!("SMOKE_FAIL {err}");
            return 3;
        }
    };
    let mut url = None;
    for _ in 0..120 {
        std::thread::sleep(Duration::from_millis(500));
        let guard = match tunnel.view.lock() {
            Ok(guard) => guard,
            Err(_) => break,
        };
        match guard.status.as_str() {
            "running" => {
                url = guard.url.clone();
                break;
            }
            "error" | "stopped" => {
                eprintln!("SMOKE_FAIL 状态={} 错误={:?}", guard.status, guard.error);
                break;
            }
            _ => {}
        }
    }
    if let Ok(logs) = tunnel.logs.lock() {
        for line in logs.iter().take(40) {
            println!("LOG {line}");
        }
    }
    if let Ok(mut guard) = tunnel.child.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
    }
    match url {
        Some(url) => {
            println!("SMOKE_OK {url}");
            0
        }
        None => {
            eprintln!("SMOKE_FAIL 未获取到公网地址");
            4
        }
    }
}

#[tauri::command]
fn stop_tunnel(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let tunnel = find_tunnel(&state, &id)?;
    kill_child(&tunnel);
    if let Ok(mut view) = tunnel.view.lock() {
        view.status = "stopped".into();
        view.url = None;
        view.error = None;
        view.paused = false;
        view.pid = None;
    }
    push_log(&tunnel.logs, "已停止");
    Ok(())
}

#[tauri::command]
fn remove_tunnel(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let removed = state
        .tunnels
        .lock()
        .map_err(|_| "隧道表锁异常".to_string())?
        .remove(&id);
    if let Some(tunnel) = removed {
        kill_child(&tunnel);
    }
    save_store(&app, state.inner());
    Ok(())
}

#[tauri::command]
fn restart_tunnel(state: State<'_, AppState>, id: String) -> Result<TunnelView, String> {
    let tunnel = find_tunnel(&state, &id)?;
    restart_inner(&state.cloudflared, &tunnel)
}

#[cfg(windows)]
fn nt_process_call(child: &Child, resume: bool) -> Result<(), String> {
    #[link(name = "ntdll")]
    extern "system" {
        fn NtSuspendProcess(handle: isize) -> i32;
        fn NtResumeProcess(handle: isize) -> i32;
    }
    use std::os::windows::io::AsRawHandle;

    let handle = child.as_raw_handle() as isize;
    let status = unsafe {
        if resume {
            NtResumeProcess(handle)
        } else {
            NtSuspendProcess(handle)
        }
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!(
            "挂起/恢复进程失败（NTSTATUS 0x{:08X}）",
            status as u32
        ))
    }
}

#[tauri::command]
fn pause_tunnel(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let tunnel = find_tunnel(&state, &id)?;
    {
        let view = tunnel.view.lock().map_err(|_| "状态锁异常".to_string())?;
        if view.paused {
            return Ok(());
        }
        if view.status != "running" && view.status != "starting" {
            return Err("只有运行中的隧道可以暂停".into());
        }
    }
    {
        let guard = tunnel.child.lock().map_err(|_| "进程锁异常".to_string())?;
        let child = guard
            .as_ref()
            .ok_or_else(|| "cloudflared 未在运行".to_string())?;
        #[cfg(windows)]
        nt_process_call(child, false)?;
    }
    if let Ok(mut view) = tunnel.view.lock() {
        view.paused = true;
    }
    push_log(
        &tunnel.logs,
        "已暂停：cloudflared 进程被挂起，公网地址暂时无法访问，点「继续」恢复",
    );
    Ok(())
}

#[tauri::command]
fn resume_tunnel(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let tunnel = find_tunnel(&state, &id)?;
    let paused = tunnel
        .view
        .lock()
        .map_err(|_| "状态锁异常".to_string())?
        .paused;
    if !paused {
        return Ok(());
    }
    {
        let guard = tunnel.child.lock().map_err(|_| "进程锁异常".to_string())?;
        let child = guard
            .as_ref()
            .ok_or_else(|| "cloudflared 未在运行".to_string())?;
        #[cfg(windows)]
        nt_process_call(child, true)?;
    }
    if let Ok(mut view) = tunnel.view.lock() {
        view.paused = false;
    }
    push_log(
        &tunnel.logs,
        "已继续运行；若公网地址已被 Cloudflare 回收，请点「重启」换一个新地址",
    );
    Ok(())
}

#[tauri::command]
fn update_tunnel(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    port: Option<u16>,
    restart: Option<bool>,
    domain: Option<String>,
    token: Option<String>,
) -> Result<TunnelView, String> {
    let tunnel = find_tunnel(&state, &id)?;
    let (current_port, active) = {
        let view = tunnel.view.lock().map_err(|_| "状态锁异常".to_string())?;
        (
            view.port,
            view.paused || view.status == "running" || view.status == "starting",
        )
    };
    let new_port = port.unwrap_or(current_port).max(1);
    let mut mode_changed = false;
    {
        let mut view = tunnel.view.lock().map_err(|_| "状态锁异常".to_string())?;
        if let Some(raw) = name {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                view.name = trimmed.chars().take(40).collect();
            }
        }
        view.port = new_port;
    }
    if let Some(raw) = domain {
        let host = raw
            .trim()
            .trim_start_matches("https://")
            .trim_end_matches('/')
            .to_string();
        let host = if host.is_empty() { None } else { Some(host) };
        let current_token = tunnel.token.lock().ok().and_then(|t| t.clone());
        let named = current_token.is_some() || host.is_some();
        if let Ok(mut guard) = tunnel.domain.lock() {
            *guard = host.clone();
        }
        if let Ok(mut view) = tunnel.view.lock() {
            view.mode = if named { "named".into() } else { "quick".into() };
            view.url = host.map(|h| format!("https://{h}"));
        }
        mode_changed = true;
    }
    if let Some(raw) = token {
        let trimmed = raw.trim().to_string();
        let value = if trimmed.is_empty() { None } else { Some(trimmed) };
        let named = value.is_some();
        if let Ok(mut guard) = tunnel.token.lock() {
            *guard = value;
        }
        if let Ok(mut view) = tunnel.view.lock() {
            view.mode = if named { "named".into() } else { "quick".into() };
            if !named {
                view.url = None;
            }
        }
        mode_changed = true;
    }
    let result = if restart.unwrap_or(active) || (mode_changed && active) {
        restart_inner(&state.cloudflared, &tunnel)?
    } else {
        if !active {
            let target = detect_origin(new_port).0;
            if let Ok(mut view) = tunnel.view.lock() {
                view.target = target;
                view.status = "stopped".into();
                if view.mode == "quick" {
                    view.url = None;
                }
                view.error = None;
                view.paused = false;
                view.pid = None;
            }
        }
        snapshot(&tunnel)?
    };
    save_store(&app, state.inner());
    Ok(result)
}

#[tauri::command]
fn tunnel_logs(state: State<'_, AppState>, id: String) -> Vec<String> {
    let map = match state.tunnels.lock() {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    match map.get(&id) {
        Some(tunnel) => tunnel
            .logs
            .lock()
            .map(|logs| logs.clone())
            .unwrap_or_default(),
        None => Vec::new(),
    }
}

#[tauri::command]
fn cloudflared_info(state: State<'_, AppState>) -> CloudflaredInfo {
    let path = state.cloudflared.display().to_string();
    let mut version = String::from("未找到 cloudflared");
    if state.cloudflared.exists() {
        let mut cmd = Command::new(&state.cloudflared);
        cmd.arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = cmd.output() {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !text.is_empty() {
                version = text.lines().next().unwrap_or("").to_string();
            }
        }
    }
    CloudflaredInfo { path, version }
}

#[tauri::command]
fn lookup_ip(ip: String) -> Result<serde_json::Value, String> {
    let trimmed = ip.trim();
    if trimmed.is_empty() {
        return Err("缺少 IP".into());
    }
    let url = format!(
        "http://ip-api.com/json/{}?fields=status,message,country,regionName,city,isp,timezone,query",
        trimmed
    );
    let response = ureq::get(&url)
        .timeout(Duration::from_secs(6))
        .call()
        .map_err(|err| format!("查询失败：{err}"))?;
    let value: serde_json::Value = response
        .into_json()
        .map_err(|err| format!("解析失败：{err}"))?;
    Ok(value)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchRow {
    pub protocol: String,
    pub url: Option<String>,
    pub samples: Vec<u64>,
    pub median_ms: Option<u64>,
    pub best_ms: Option<u64>,
    pub worst_ms: Option<u64>,
    pub error: Option<String>,
}

/// 对同一源端口，用临时 cloudflared 分别以 quic / http2 开隧道，
/// 各自请求 `rounds` 次并记录 TTFB，用完立即关闭；不影响已存在的隧道。
#[tauri::command]
async fn bench_protocols(
    app: AppHandle,
    port: u16,
    rounds: Option<u32>,
) -> Result<Vec<BenchRow>, String> {
    let exe = {
        let state = app.state::<AppState>();
        state.cloudflared.clone()
    };
    let rounds = rounds.unwrap_or(3).clamp(1, 6);
    tauri::async_runtime::spawn_blocking(move || {
        ["quic", "http2"]
            .iter()
            .map(|proto| bench_one(&exe, port, proto, rounds))
            .collect::<Vec<BenchRow>>()
    })
    .await
    .map_err(|err| format!("测速任务异常：{err}"))
}

/// 用系统自带 curl 测一次首字节耗时（毫秒）。curl 会做 IPv4/IPv6 Happy Eyeballs，
/// 比直接用 getaddrinfo 更接近浏览器的真实行为。
fn curl_ttfb(url: &str, max_time_secs: u32) -> Result<u64, String> {
    let max_time = max_time_secs.to_string();
    let mut cmd = Command::new("curl");
    cmd.args([
        "-s",
        "-o",
        "NUL",
        "--max-time",
        &max_time,
        "-w",
        "%{http_code} %{time_starttransfer}",
        url,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|err| format!("调用 curl 失败：{err}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut parts = text.split_whitespace();
    let code = parts.next().unwrap_or("000");
    let ttfb = parts.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    if code == "000" || ttfb <= 0.0 {
        let err = String::from_utf8_lossy(&output.stderr);
        let detail: String = err.trim().chars().take(120).collect();
        let status = output.status.code().unwrap_or(-1);
        return Err(if detail.is_empty() {
            format!("请求失败：curl 退出码 {status}，HTTP {code}")
        } else {
            format!("请求失败：{detail}")
        });
    }
    Ok((ttfb * 1000.0).round() as u64)
}

fn bench_one(exe: &std::path::Path, port: u16, proto: &str, rounds: u32) -> BenchRow {    let mut row = BenchRow {
        protocol: proto.to_string(),
        url: None,
        samples: Vec::new(),
        median_ms: None,
        best_ms: None,
        worst_ms: None,
        error: None,
    };

    let (target, reachable) = detect_origin(port);
    if !reachable {
        row.error = Some("本地端口没有响应".into());
        return row;
    }

    let mut cmd = Command::new(exe);
    cmd.arg("tunnel")
        .arg("--no-autoupdate")
        .arg("--protocol")
        .arg(proto)
        .arg("--url")
        .arg(&target)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            row.error = Some(format!("启动 cloudflared 失败：{err}"));
            return row;
        }
    };
    #[cfg(windows)]
    job::bind_child(&child);

    let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        let store = lines.clone();
        std::thread::spawn(move || {
            let mut buf = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match buf.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
                let text = line.trim_end_matches(['\r', '\n']).to_string();
                if text.is_empty() {
                    continue;
                }
                if let Ok(mut list) = store.lock() {
                    if list.len() < MAX_LOGS {
                        list.push(text);
                    }
                }
            }
        });
    }

    // 等 cloudflared 报出公网地址，最多 30 秒。
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut url: Option<String> = None;
    while std::time::Instant::now() < deadline {
        if let Ok(list) = lines.lock() {
            if let Some(found) = list.iter().find_map(|line| extract_url(line)) {
                url = Some(found);
                break;
            }
        }
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    let Some(url) = url else {
        let reason = lines
            .lock()
            .ok()
            .and_then(|list| {
                list.iter()
                    .rev()
                    .find(|line| {
                        let lower = line.to_lowercase();
                        lower.contains("err") || lower.contains("fail") || lower.contains("429")
                    })
                    .cloned()
            })
            .unwrap_or_else(|| "30 秒内没有拿到公网地址".to_string());
        let _ = child.kill();
        let _ = child.wait();
        row.error = Some(reason.chars().take(160).collect());
        return row;
    };

    // 地址刚分配时 DNS 往往还没生效，先轮询到真正可访问，最多 60 秒。
    let warm_deadline = std::time::Instant::now() + Duration::from_secs(60);
    let mut last_err: Option<String> = None;
    let mut ready = false;
    while std::time::Instant::now() < warm_deadline {
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        match curl_ttfb(&url, 20) {
            Ok(_) => {
                ready = true;
                break;
            }
            Err(err) => {
                last_err = Some(err);
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    }

    if !ready {
        let _ = child.kill();
        let _ = child.wait();
        row.url = Some(url);
        let reason = last_err.unwrap_or_else(|| "隧道未就绪".into());
        let hint = lines
            .lock()
            .ok()
            .and_then(|list| {
                list.iter()
                    .rev()
                    .find(|line| {
                        let lower = line.to_lowercase();
                        lower.contains("err") || lower.contains("fail") || lower.contains("429")
                    })
                    .cloned()
            });
        let text = match hint {
            Some(line) => format!("{reason}（cloudflared: {}）", line.chars().take(110).collect::<String>()),
            None => reason,
        };
        row.error = Some(text.chars().take(200).collect());
        return row;
    }

    for _ in 0..rounds {
        // 单次失败重试一次，避免边缘偶发抖动污染样本。
        let mut attempt = 0;
        loop {
            match curl_ttfb(&url, 25) {
                Ok(ms) => {
                    row.samples.push(ms);
                    break;
                }
                Err(err) => {
                    attempt += 1;
                    if attempt >= 2 {
                        if row.error.is_none() {
                            row.error = Some(err);
                        }
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(800));
                }
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();

    if row.samples.is_empty() {
        if row.error.is_none() {
            row.error = Some("没有成功的请求".into());
        }
        return row;
    }

    let mut sorted = row.samples.clone();
    sorted.sort_unstable();
    row.best_ms = sorted.first().copied();
    row.worst_ms = sorted.last().copied();
    row.median_ms = Some(sorted[sorted.len() / 2]);
    row.url = Some(url);
    row
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureRow {
    pub url: String,
    pub samples: Vec<u64>,
    pub median_ms: Option<u64>,
    pub best_ms: Option<u64>,
    pub worst_ms: Option<u64>,
    pub error: Option<String>,
}

/// 对一条正在运行的隧道实测 TTFB：直接打它的公网地址，不再新开隧道，
/// 因此没有 DNS 传播和 429 频控的干扰。
#[tauri::command]
async fn measure_tunnel(app: AppHandle, id: String, rounds: Option<u32>) -> Result<MeasureRow, String> {
    let url = {
        let state = app.state::<AppState>();
        let map = state.tunnels.lock().map_err(|_| "状态锁异常".to_string())?;
        let tunnel = map.get(&id).ok_or_else(|| "隧道不存在".to_string())?;
        let view = tunnel.view.lock().map_err(|_| "状态锁异常".to_string())?;
        if view.paused {
            return Err("隧道已暂停，公网现在不可访问；先「继续」再测速".into());
        }
        view.url
            .clone()
            .ok_or_else(|| "这条隧道还没有公网地址".to_string())?
    };
    let rounds = rounds.unwrap_or(3).clamp(1, 8);

    tauri::async_runtime::spawn_blocking(move || {
        let mut row = MeasureRow {
            url: url.clone(),
            samples: Vec::new(),
            median_ms: None,
            best_ms: None,
            worst_ms: None,
            error: None,
        };
        // 地址刚分配时 DNS 可能还没生效，先等它真正可访问（最多 30 秒），这段时间不计入样本。
        let warm_deadline = std::time::Instant::now() + Duration::from_secs(30);
        let mut last_err: Option<String> = None;
        while std::time::Instant::now() < warm_deadline {
            match curl_ttfb(&url, 20) {
                Ok(_) => break,
                Err(err) => {
                    last_err = Some(err);
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        }

        for _ in 0..rounds {
            match curl_ttfb(&url, 25) {
                Ok(ms) => row.samples.push(ms),
                Err(err) => {
                    if row.error.is_none() {
                        row.error = Some(match last_err.clone() {
                            Some(_) => "公网地址还在生效中（Cloudflare DNS 传播通常 10–30 秒），过几秒再测一次".into(),
                            None => err,
                        });
                    }
                }
            }
        }
        if let Some(&best) = row.samples.iter().min() {
            row.best_ms = Some(best);
        }
        if let Some(&worst) = row.samples.iter().max() {
            row.worst_ms = Some(worst);
        }
        let mut sorted = row.samples.clone();
        sorted.sort_unstable();
        if !sorted.is_empty() {
            row.median_ms = Some(sorted[sorted.len() / 2]);
        }
        row
    })
    .await
    .map_err(|err| format!("测速任务异常：{err}"))
}

fn autostart_command(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|err| format!("获取程序路径失败：{err}"))?;
    let mut cmd = Command::new("reg");
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    if enabled {
        cmd.args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "lin-tunnel",
            "/t",
            "REG_SZ",
            "/d",
            &format!("\"{}\"", exe.display()),
            "/f",
        ]);
    } else {
        cmd.args([
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "lin-tunnel",
            "/f",
        ]);
    }
    let _ = app;
    let status = cmd
        .status()
        .map_err(|err| format!("调用注册表命令失败：{err}"))?;
    Ok(status.success())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    autostart_command(&app, enabled)?;
    Ok(enabled)
}

#[tauri::command]
fn get_autostart() -> Result<bool, String> {
    let mut cmd = Command::new("reg");
    cmd.args([
        "query",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
        "/v",
        "lin-tunnel",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|err| format!("读取注册表失败：{err}"))?;
    Ok(output.status.success() && !output.stdout.is_empty())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let cloudflared = find_cloudflared(app.handle());
            app.manage(AppState {
                tunnels: Mutex::new(HashMap::new()),
                cloudflared,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_tunnels,
            restore_tunnels,
            start_tunnel,
            stop_tunnel,
            restart_tunnel,
            pause_tunnel,
            resume_tunnel,
            update_tunnel,
            remove_tunnel,
            tunnel_logs,
            cloudflared_info,
            lookup_ip,
            bench_protocols,
            measure_tunnel,
            set_autostart,
            get_autostart
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<AppState>();
                let tunnels: Vec<Arc<Tunnel>> = match state.tunnels.lock() {
                    Ok(map) => map.values().cloned().collect(),
                    Err(_) => Vec::new(),
                };
                for tunnel in tunnels {
                    if let Ok(mut guard) = tunnel.child.lock() {
                        if let Some(child) = guard.as_mut() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::extract_url;

    #[test]
    fn accepts_real_quick_tunnel_url() {
        assert_eq!(
            extract_url("INF |  https://abc-def-ghi.trycloudflare.com  |").as_deref(),
            Some("https://abc-def-ghi.trycloudflare.com")
        );
    }

    #[test]
    fn ignores_api_endpoint() {
        assert!(extract_url(
            "ERR Failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": 429"
        )
        .is_none());
        assert!(extract_url("see https://trycloudflare.com/terms").is_none());
    }
}
