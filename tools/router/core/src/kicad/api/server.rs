//! A headless KiCad API server on one board: `kicad-cli-nightly api-server --socket S FILE`, stopped when dropped.
use super::client::Client;
use super::proto::kiapi::common::ApiStatusCode;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

const DEFAULT_CLI: &str = "kicad-cli-nightly";
/// Start took 0.62 s on MC-MAIN; a loaded host gets room.
const START_TIMEOUT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(50);

static NEXT_SERVER: AtomicU32 = AtomicU32::new(0);

pub struct Server {
    child: Child,
    folder: PathBuf,
}

impl Server {
    /// Starts a server on `board` and waits until it answers. Env KICAD_API_CLI names the binary.
    pub fn start(board: &Path) -> Result<(Server, Client), String> {
        let cli = std::env::var("KICAD_API_CLI").unwrap_or_else(|_| DEFAULT_CLI.to_string());
        Self::start_with_cli(board, &cli)
    }

    /// Explicit runtime selection for isolated probes; production's default remains unchanged.
    pub fn start_with_cli(board: &Path, cli: &str) -> Result<(Server, Client), String> {
        let folder = std::env::temp_dir().join(format!("iotroute-api-{}-{}", std::process::id(), NEXT_SERVER.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
        let socket = folder.join("api.sock");
        let log = fs::File::create(folder.join("server.log")).map_err(|e| e.to_string())?;
        let child = Command::new(cli).arg("api-server").arg("--socket").arg(&socket).arg(board)
            .stdin(Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log)
            .spawn().map_err(|e| format!("{cli}: {e}"))?;
        let mut server = Server { child, folder };
        let client = server.wait_ready(&socket)?;
        Ok((server, client))
    }

    fn wait_ready(&mut self, socket: &Path) -> Result<Client, String> {
        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().map_err(|e| e.to_string())? {
                return Err(format!("the API server stopped ({status}): {}", self.log_tail()));
            }
            if socket.exists()
                && let Ok(mut client) = Client::connect(socket)
            {
                match client.ping() {
                    Ok(()) => return Ok(client),
                    Err(e) if e.status == ApiStatusCode::AsNotReady => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            sleep(POLL);
        }
        Err(format!("the API server did not answer in {} s: {}", START_TIMEOUT.as_secs(), self.log_tail()))
    }

    fn log_tail(&self) -> String {
        let text = fs::read_to_string(self.folder.join("server.log")).unwrap_or_default();
        let start = text.floor_char_boundary(text.len().saturating_sub(500));
        text[start..].trim().to_string()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.folder);
    }
}
