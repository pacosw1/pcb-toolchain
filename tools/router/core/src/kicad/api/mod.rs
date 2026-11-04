//! Client of KiCad's IPC API (protos pinned in core/proto, see core/proto/PIN). Boards are read through it, not parsed: a server
//! on the nightly build opens the file and answers. Never save a board from it: KiCad 10 may not read it back.
pub mod client;
#[allow(clippy::all, unused_qualifications)]
pub mod proto;
pub mod server;
mod transport;

pub use client::{ApiError, Client, decode};
pub use server::Server;
