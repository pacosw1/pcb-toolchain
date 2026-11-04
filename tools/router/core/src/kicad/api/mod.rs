//! Client of KiCad's IPC API (protos pinned in core/proto, see core/proto/PIN). Boards are read through it, not parsed: a server
//! on the nightly build opens the file and answers. Never save a board from it: KiCad 10 may not read it back.
/// The KiCad commit of core/proto.
pub const PINNED_COMMIT: &str = "4fe1ca20605d722a8972dabe11b4a90fc6b3d879";

pub mod client;
#[allow(clippy::all, unused_qualifications)]
pub mod proto;
mod read;
pub mod server;
mod transport;

pub use client::{ApiError, Client, decode};
pub use read::read_board;
pub use server::Server;
