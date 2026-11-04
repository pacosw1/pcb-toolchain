// Scratch: never committed. dsn_probe BOARD OUT.dsn: every copper item locked, exported through the API job.
use iotroute::kicad::api::{Server, read_board};
use iotroute::specctra::export::{Throwaway, with_locks};
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let board = Path::new(&args[1]);
    let text = std::fs::read_to_string(board).unwrap();
    let (server, mut client) = Server::start(board).unwrap();
    let read = read_board(&mut client, board).unwrap();
    drop(server);
    let ids = read.copper.iter().map(|item| match item {
        iotroute::kicad::board::RoutedCopper::Track(track) => track.id.clone(),
        iotroute::kicad::board::RoutedCopper::Via(via) => via.id.clone(),
    }).collect();
    let locked = with_locks(&text, &ids).unwrap();
    let copy = Throwaway::new(board, Path::new(&args[2])).unwrap();
    let again = copy.read(&locked, Some(Path::new(&args[2]))).unwrap();
    println!("read {} copper, export done", again.copper.len());
}
