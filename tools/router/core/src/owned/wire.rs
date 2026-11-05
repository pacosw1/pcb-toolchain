//! The frame of lean_owned.py: a 4-byte big-endian length, then JSON. Descriptors ride SCM_RIGHTS on the first bytes.

use super::failure::Failure;
use super::native::set_cloexec;
use serde::Serialize;
use serde_json::Value;
use std::io::{self, Read, Write};
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;

pub const MAX_FRAME: usize = 128 * 1024 * 1024;
pub const MAX_FDS: usize = 16;
const HEADER_BYTES: usize = 4;

fn space_for_fds(count: usize) -> usize {
    unsafe { libc::CMSG_SPACE((count * size_of::<RawFd>()) as u32) as usize }
}

/// A cmsg buffer needs the alignment of cmsghdr; u64 words give it on both systems.
fn control_buffer(bytes: usize) -> Vec<u64> {
    vec![0; bytes.div_ceil(size_of::<u64>())]
}

fn send_first(socket: &UnixStream, packet: &[u8], fds: &[RawFd]) -> io::Result<usize> {
    let mut part = libc::iovec { iov_base: packet.as_ptr() as *mut _, iov_len: packet.len() };
    let mut header: libc::msghdr = unsafe { zeroed() };
    header.msg_iov = &mut part;
    header.msg_iovlen = 1;
    let mut control = control_buffer(space_for_fds(fds.len()));
    if !fds.is_empty() {
        header.msg_control = control.as_mut_ptr().cast();
        header.msg_controllen = space_for_fds(fds.len()) as _;
        unsafe {
            let message = libc::CMSG_FIRSTHDR(&header);
            (*message).cmsg_level = libc::SOL_SOCKET;
            (*message).cmsg_type = libc::SCM_RIGHTS;
            (*message).cmsg_len = libc::CMSG_LEN((fds.len() * size_of::<RawFd>()) as u32) as _;
            std::ptr::copy_nonoverlapping(fds.as_ptr(), libc::CMSG_DATA(message).cast(), fds.len());
        }
    }
    loop {
        let sent = unsafe { libc::sendmsg(socket.as_raw_fd(), &header, 0) };
        if sent >= 0 {
            return Ok(sent as usize);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINTR) {
            return Err(error);
        }
    }
}

pub fn send(socket: &UnixStream, message: &impl Serialize, fds: &[RawFd]) -> Result<(), Failure> {
    let data = serde_json::to_vec(message)?;
    if data.len() > MAX_FRAME || fds.len() > MAX_FDS {
        return Err(Failure::value("owned-stage frame/descriptor bound exceeded"));
    }
    let mut packet = Vec::with_capacity(HEADER_BYTES + data.len());
    packet.extend_from_slice(&(data.len() as u32).to_be_bytes());
    packet.extend_from_slice(&data);
    let sent = send_first(socket, &packet, fds)?;
    let mut rest = socket;
    rest.write_all(&packet[sent..])?;
    Ok(())
}

/// Takes ownership of every descriptor first, so an invalid frame still closes them.
fn received_fds(header: &libc::msghdr) -> Result<Vec<OwnedFd>, Failure> {
    let mut fds = Vec::new();
    let mut unexpected = false;
    unsafe {
        let mut message = libc::CMSG_FIRSTHDR(header);
        while !message.is_null() {
            if (*message).cmsg_level == libc::SOL_SOCKET && (*message).cmsg_type == libc::SCM_RIGHTS {
                let bytes = (*message).cmsg_len as usize - libc::CMSG_LEN(0) as usize;
                let data: *const RawFd = libc::CMSG_DATA(message).cast();
                for index in 0..bytes / size_of::<RawFd>() {
                    fds.push(OwnedFd::from_raw_fd(data.add(index).read_unaligned()));
                }
            } else {
                unexpected = true;
            }
            message = libc::CMSG_NXTHDR(header, message);
        }
    }
    for fd in &fds {
        set_cloexec(fd.as_raw_fd(), true)?;
    }
    if unexpected {
        return Err(Failure::value("unexpected owned-stage ancillary data"));
    }
    if header.msg_flags & libc::MSG_CTRUNC != 0 || fds.len() > MAX_FDS {
        return Err(Failure::value("truncated/excessive owned-stage descriptors"));
    }
    Ok(fds)
}

fn receive_first(socket: &UnixStream, bytes: &mut [u8]) -> Result<(usize, Vec<OwnedFd>), Failure> {
    let mut part = libc::iovec { iov_base: bytes.as_mut_ptr().cast(), iov_len: bytes.len() };
    let mut control = control_buffer(space_for_fds(MAX_FDS));
    let mut header: libc::msghdr = unsafe { zeroed() };
    header.msg_iov = &mut part;
    header.msg_iovlen = 1;
    header.msg_control = control.as_mut_ptr().cast();
    header.msg_controllen = space_for_fds(MAX_FDS) as _;
    #[cfg(target_os = "linux")]
    let flags = libc::MSG_CMSG_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    let flags = 0;
    loop {
        let count = unsafe { libc::recvmsg(socket.as_raw_fd(), &mut header, flags) };
        if count >= 0 {
            return Ok((count as usize, received_fds(&header)?));
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINTR) {
            return Err(error.into());
        }
    }
}

fn read_all(socket: &UnixStream, bytes: &mut [u8]) -> Result<(), Failure> {
    let mut source = socket;
    source.read_exact(bytes).map_err(|error| match error.kind() {
        io::ErrorKind::UnexpectedEof => Failure::new("OSError", "owned-stage connection closed"),
        _ => error.into(),
    })
}

pub fn receive(socket: &UnixStream) -> Result<(Value, Vec<OwnedFd>), Failure> {
    let mut header = [0u8; HEADER_BYTES];
    let (count, fds) = receive_first(socket, &mut header)?;
    if count == 0 {
        return Err(Failure::new("OSError", "owned-stage connection closed"));
    }
    read_all(socket, &mut header[count..])?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME {
        return Err(Failure::value("invalid owned-stage frame size"));
    }
    let mut body = vec![0; size];
    read_all(socket, &mut body)?;
    Ok((serde_json::from_slice(&body)?, fds))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs::File;
    use std::io::Seek;

    fn pair() -> (UnixStream, UnixStream) {
        UnixStream::pair().unwrap()
    }

    #[test]
    fn a_message_and_its_descriptors_round_trip() {
        let (left, right) = pair();
        let path = std::env::temp_dir().join(format!("owned-wire-{}", std::process::id()));
        std::fs::write(&path, b"payload").unwrap();
        let file = File::open(&path).unwrap();
        send(&left, &json!({"op": "spawn"}), &[file.as_raw_fd()]).unwrap();
        let (message, mut fds) = receive(&right).unwrap();
        assert_eq!(message, json!({"op": "spawn"}));
        let mut received = File::from(fds.pop().unwrap());
        received.rewind().unwrap();
        let mut text = String::new();
        received.read_to_string(&mut text).unwrap();
        assert_eq!(text, "payload");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn the_frame_is_a_big_endian_length_and_compact_json() {
        let (left, mut right) = pair();
        send(&left, &json!({"a": 1}), &[]).unwrap();
        let mut bytes = [0u8; 11];
        right.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"\0\0\0\x07{\"a\":1}");
    }

    #[test]
    fn a_zero_or_oversized_length_is_rejected() {
        for header in [[0u8; 4], [0xff; 4]] {
            let (mut left, right) = pair();
            left.write_all(&header).unwrap();
            assert!(receive(&right).unwrap_err().message.contains("frame size"));
        }
    }

    #[test]
    fn a_closed_peer_is_an_error_not_a_message() {
        let (left, right) = pair();
        drop(left);
        assert!(receive(&right).unwrap_err().message.contains("connection closed"));
    }

    #[test]
    fn too_many_descriptors_are_refused_on_send() {
        let (left, _right) = pair();
        let fds = vec![left.as_raw_fd(); MAX_FDS + 1];
        assert!(send(&left, &json!({}), &fds).unwrap_err().message.contains("bound exceeded"));
    }
}
