import fs from 'node:fs'

const path = 'src-tauri/src/lib.rs'
let src = fs.readFileSync(path, 'utf8')
const newLaunch = fs.readFileSync('_patch/new_launch.rs', 'utf8')
const newCommands = fs.readFileSync('_patch/new_commands.rs', 'utf8')

function replaceOnce(needle, replacement, label) {
  const hits = src.split(needle).length - 1
  if (hits !== 1) {
    console.error(`FAIL ${label}: expected 1 match, got ${hits}`)
    process.exit(1)
  }
  src = src.replace(needle, replacement)
  console.log(`ok ${label}`)
}

// 1. imports
replaceOnce(
  "use std::sync::{Arc, Mutex};",
  "use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};\nuse std::sync::{Arc, Mutex};",
  'imports',
)

// 2. TunnelView.paused
replaceOnce(
  "pub struct TunnelView {\n    pub id: String,\n    pub name: String,\n    pub port: u16,\n    pub target: String,\n    pub status: String,\n",
  "pub struct TunnelView {\n    pub id: String,\n    pub name: String,\n    pub port: u16,\n    pub target: String,\n    pub status: String,\n    pub paused: bool,\n",
  'TunnelView.paused',
)

// 3. Tunnel.generation
replaceOnce(
  "pub struct Tunnel {\n    pub view: Arc<Mutex<TunnelView>>,\n    pub logs: Arc<Mutex<Vec<String>>>,\n    pub child: Mutex<Option<Child>>,\n}",
  "pub struct Tunnel {\n    pub view: Arc<Mutex<TunnelView>>,\n    pub logs: Arc<Mutex<Vec<String>>>,\n    pub child: Mutex<Option<Child>>,\n    /// 每次启动/停止递增；守护线程据此判断自己是否过期。\n    pub generation: Arc<AtomicU64>,\n}",
  'Tunnel.generation',
)

// 4. launch_tunnel .. (up to start_tunnel command)
const launchStart = src.indexOf('fn launch_tunnel(')
const launchEnd = src.indexOf("#[tauri::command]\nfn start_tunnel(")
if (launchStart < 0 || launchEnd < 0 || launchEnd < launchStart) {
  console.error('FAIL launch block markers')
  process.exit(1)
}
src = src.slice(0, launchStart) + newLaunch + src.slice(launchEnd)
console.log('ok launch block')

// 5. stop_tunnel rewrite
const stopStart = src.indexOf("fn stop_tunnel(state: State<'_, AppState>, id: String) -> Result<(), String> {")
const stopEnd = src.indexOf("#[tauri::command]\nfn remove_tunnel(")
if (stopStart < 0 || stopEnd < stopStart) {
  console.error('FAIL stop block markers')
  process.exit(1)
}
const newStop = `fn stop_tunnel(state: State<'_, AppState>, id: String) -> Result<(), String> {
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

`
src = src.slice(0, stopStart) + newStop + src.slice(stopEnd)
console.log('ok stop_tunnel')

// 6. remove_tunnel uses kill_child
replaceOnce(
  `    if let Some(tunnel) = removed {
        if let Ok(mut guard) = tunnel.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
            }
        }
    }`,
  `    if let Some(tunnel) = removed {
        kill_child(&tunnel);
    }`,
  'remove_tunnel',
)

// 7. register new commands
replaceOnce(
  "            start_tunnel,\n            stop_tunnel,",
  "            start_tunnel,\n            stop_tunnel,\n            restart_tunnel,\n            pause_tunnel,\n            resume_tunnel,\n            update_tunnel,",
  'handler list',
)

// 8. append new commands before tunnel_logs
replaceOnce(
  "#[tauri::command]\nfn tunnel_logs(",
  newCommands + "#[tauri::command]\nfn tunnel_logs(",
  'new commands',
)

fs.writeFileSync(path, src, 'utf8')
console.log('PATCHED', src.length)
