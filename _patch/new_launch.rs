static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn spawn_cloudflared(exe: &std::path::Path, port: u16) -> Result<(Child, String, bool), String> {
    let (target, reachable) = detect_origin(port);
    let exe_display = exe.display().to_string();
    let mut cmd = Command::new(exe);
    cmd.arg("tunnel")
        .arg("--no-autoupdate")
        .arg("--url")
        .arg(&target)
        .stdout(Stdio::piped())
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
    let (mut child, target, reachable) = spawn_cloudflared(exe, port)?;
    let pid = child.id();
    // 每次启动递增代号，上一代的守护线程看到代号变化后自行退出。
    let gen = tunnel.generation.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut view = tunnel.view.lock().map_err(|_| "状态锁异常".to_string())?;
        view.target = target.clone();
        view.status = "starting".into();
        view.url = None;
        view.paused = false;
        view.pid = Some(pid);
        view.error = if reachable {
            None
        } else {
            Some(format!("本机 {port} 端口当前没有监听，服务启动后需重启隧道"))
        };
    }
    push_log(
        &tunnel.logs,
        &format!("$ {} tunnel --url {target}", exe.display()),
    );

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
                if let Ok(mut v) = tunnel_ref.view.lock() {
                    if v.status != "error" {
                        v.status = "stopped".into();
                    }
                    v.paused = false;
                    if v.url.is_none() && v.error.is_none() {
                        v.error = Some(format!(
                            "cloudflared 已退出（{}）",
                            code.map(|c| format!("code {c}"))
                                .unwrap_or_else(|| "无退出码".into())
                        ));
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
) -> Result<Arc<Tunnel>, String> {
    let id = format!("t{}-{}", now_secs(), NEXT_ID.fetch_add(1, Ordering::SeqCst));
    let view = Arc::new(Mutex::new(TunnelView {
        id: id.clone(),
        name: name.unwrap_or_else(|| format!("端口 {port}")),
        port,
        target: format!("http://127.0.0.1:{port}"),
        status: "starting".into(),
        paused: false,
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

