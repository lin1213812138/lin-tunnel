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
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    port: Option<u16>,
    restart: Option<bool>,
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
    if restart.unwrap_or(active) {
        return restart_inner(&state.cloudflared, &tunnel);
    }
    if !active {
        let target = detect_origin(new_port).0;
        if let Ok(mut view) = tunnel.view.lock() {
            view.target = target;
            view.status = "stopped".into();
            view.url = None;
            view.error = None;
            view.paused = false;
            view.pid = None;
        }
    }
    snapshot(&tunnel)
}

