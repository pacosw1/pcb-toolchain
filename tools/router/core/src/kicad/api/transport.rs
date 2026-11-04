//! The nng REQ side of KiCad's API socket, on a Unix socket. The wire format is small enough to speak directly, which keeps the
//! C library and its cmake build out of the binary: an 8-byte SP greeting each way, then per message a type byte, a big-endian
//! 64-bit length, and the body. A REQ body starts with a 32-bit request id whose top bit is set; the reply repeats it.
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

const REQ: u16 = 0x30;
const REP: u16 = 0x31;
const MESSAGE: u8 = 1;
const ID_BIT: u32 = 0x8000_0000;
/// KiCad answers a whole-board read in well under a second; this only stops a dead server from hanging a job.
const REPLY_TIMEOUT: Duration = Duration::from_secs(120);

pub struct Pipe {
    stream: UnixStream,
    next_id: u32,
}

fn greeting(protocol: u16) -> [u8; 8] {
    let [hi, lo] = protocol.to_be_bytes();
    [0, b'S', b'P', 0, hi, lo, 0, 0]
}

impl Pipe {
    pub fn connect(socket: &Path) -> Result<Pipe, String> {
        let fail = |e: std::io::Error| format!("{}: {e}", socket.display());
        let mut stream = UnixStream::connect(socket).map_err(fail)?;
        stream.set_read_timeout(Some(REPLY_TIMEOUT)).map_err(fail)?;
        stream.write_all(&greeting(REQ)).map_err(fail)?;
        let mut peer = [0u8; 8];
        stream.read_exact(&mut peer).map_err(fail)?;
        if peer != greeting(REP) {
            return Err(format!("{}: not a REP socket: {peer:?}", socket.display()));
        }
        Ok(Pipe { stream, next_id: 1 })
    }

    /// One request and its reply.
    pub fn request(&mut self, body: &[u8]) -> Result<Vec<u8>, String> {
        let id = (self.next_id | ID_BIT).to_be_bytes();
        self.next_id = self.next_id.wrapping_add(1) & !ID_BIT;
        self.stream.write_all(&frame(&id, body)).map_err(|e| format!("send: {e}"))?;
        let reply = self.read_message()?;
        match reply.split_at_checked(4) {
            Some((got, rest)) if got == id => Ok(rest.to_vec()),
            _ => Err("reply to another request".to_string()),
        }
    }

    fn read_message(&mut self) -> Result<Vec<u8>, String> {
        let mut head = [0u8; 9];
        self.stream.read_exact(&mut head).map_err(|e| format!("receive: {e}"))?;
        if head[0] != MESSAGE {
            return Err(format!("bad message type {}", head[0]));
        }
        let len = u64::from_be_bytes(head[1..].try_into().expect("eight bytes"));
        let mut message = vec![0u8; len as usize];
        self.stream.read_exact(&mut message).map_err(|e| format!("receive: {e}"))?;
        Ok(message)
    }
}

fn frame(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(13 + body.len());
    out.push(MESSAGE);
    out.extend_from_slice(&((id.len() + body.len()) as u64).to_be_bytes());
    out.extend_from_slice(id);
    out.extend_from_slice(body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::thread;

    /// A REP peer that echoes one message with the reply body `pong`.
    fn serve(listener: UnixListener) {
        let (mut s, _) = listener.accept().unwrap();
        let mut hello = [0u8; 8];
        s.read_exact(&mut hello).unwrap();
        assert_eq!(hello, greeting(REQ));
        s.write_all(&greeting(REP)).unwrap();
        let mut head = [0u8; 9];
        s.read_exact(&mut head).unwrap();
        let mut body = vec![0u8; u64::from_be_bytes(head[1..].try_into().unwrap()) as usize];
        s.read_exact(&mut body).unwrap();
        assert_eq!(body[0] & 0x80, 0x80, "the id has its top bit set");
        assert_eq!(&body[4..], b"ping");
        let id: [u8; 4] = body[..4].try_into().unwrap();
        s.write_all(&frame(&id, b"pong")).unwrap();
    }

    #[test]
    fn a_request_gets_the_reply_with_its_id() {
        let dir = std::env::temp_dir().join(format!("iotroute-pipe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        let peer = thread::spawn(move || serve(listener));
        let mut pipe = Pipe::connect(&path).unwrap();
        assert_eq!(pipe.request(b"ping").unwrap(), b"pong");
        peer.join().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
