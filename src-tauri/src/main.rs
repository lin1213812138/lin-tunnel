#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(index) = args.iter().position(|arg| arg == "--smoke") {
        let port = args
            .get(index + 1)
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8080);
        std::process::exit(lin_tunnel_lib::smoke(port));
    }
    lin_tunnel_lib::run()
}
