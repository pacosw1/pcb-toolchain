//! Non-blocking collection of child pipes. With nothing open, a pump just sleeps, so it also paces the broker loops.

use super::failure::Failure;
use super::native::{poll_input, set_nonblocking};
use super::wire::MAX_FRAME;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::time::Duration;

const READ_BYTES: usize = 65536;

struct Stream {
    fd: Option<OwnedFd>,
    data: Vec<u8>,
}

#[derive(Default)]
pub struct Capture {
    streams: Vec<Stream>,
}

impl Capture {
    /// Returns the index for `take`.
    pub fn add(&mut self, fd: OwnedFd) -> io::Result<usize> {
        set_nonblocking(fd.as_raw_fd())?;
        self.streams.push(Stream { fd: Some(fd), data: Vec::new() });
        Ok(self.streams.len() - 1)
    }

    pub fn is_open(&self) -> bool {
        self.streams.iter().any(|stream| stream.fd.is_some())
    }

    pub fn take(&mut self, index: usize) -> Vec<u8> {
        std::mem::take(&mut self.streams[index].data)
    }

    pub fn pump(&mut self, timeout: Duration) -> Result<(), Failure> {
        let mut waiting: Vec<libc::pollfd> = self.streams.iter().filter_map(|stream| stream.fd.as_ref())
            .map(|fd| libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLIN, revents: 0 }).collect();
        if waiting.is_empty() {
            std::thread::sleep(timeout);
            return Ok(());
        }
        poll_input(&mut waiting, timeout)?;
        for ready in waiting.iter().filter(|entry| entry.revents != 0) {
            let stream = self.streams.iter_mut().find(|stream| stream.fd.as_ref().is_some_and(|fd| fd.as_raw_fd() == ready.fd));
            stream.map_or(Ok(()), read_some)?;
        }
        Ok(())
    }
}

fn read_some(stream: &mut Stream) -> Result<(), Failure> {
    let Some(fd) = &stream.fd else { return Ok(()) };
    let mut chunk = [0u8; READ_BYTES];
    let count = unsafe { libc::read(fd.as_raw_fd(), chunk.as_mut_ptr().cast(), chunk.len()) };
    if count < 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::EAGAIN) | Some(libc::EINTR) => Ok(()),
            _ => Err(error.into()),
        };
    }
    if count == 0 {
        stream.fd = None;
        return Ok(());
    }
    stream.data.extend_from_slice(&chunk[..count as usize]);
    if stream.data.len() > MAX_FRAME / 2 {
        return Err(Failure::value("owned-stage captured output bound exceeded"));
    }
    Ok(())
}
