//! Typed calls on the KiCad API: each request and reply is a protobuf message in the envelope of common/envelope.proto.
use super::proto::kiapi::board::commands::{GetNets, NetsResponse};
use super::proto::kiapi::board::types::Net;
use super::proto::kiapi::common::commands::{GetItems, GetItemsResponse, GetOpenDocuments, GetOpenDocumentsResponse, GetVersion, GetVersionResponse, Ping};
use super::proto::kiapi::common::types::{DocumentSpecifier, DocumentType, ItemHeader, ItemRequestStatus, KiCadObjectType, KiCadVersion};
use super::proto::kiapi::common::{ApiRequest, ApiRequestHeader, ApiResponse, ApiStatusCode};
use super::transport::Pipe;
use prost::{Message, Name};
use prost_types::Any;
use std::path::Path;

/// A refused or failed call.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    pub status: ApiStatusCode,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "KiCad API {}: {}", self.status.as_str_name(), self.message)
    }
}

impl From<String> for ApiError {
    fn from(message: String) -> ApiError {
        ApiError { status: ApiStatusCode::AsUnknown, message }
    }
}

pub struct Client {
    pipe: Pipe,
    client_name: String,
}

impl Client {
    pub fn connect(socket: &Path) -> Result<Client, String> {
        Ok(Client { pipe: Pipe::connect(socket)?, client_name: format!("iotroute-{}", std::process::id()) })
    }

    /// One API call: the request's reply as `S`.
    pub fn call<R: Name, S: Name + Default>(&mut self, request: &R) -> Result<S, ApiError> {
        let reply = self.exchange(request)?;
        let message = reply.message.ok_or_else(|| format!("no message in the reply to {}", R::NAME))?;
        message.to_msg().map_err(|e| ApiError::from(format!("reply to {}: {e}", R::NAME)))
    }

    fn exchange<R: Name>(&mut self, request: &R) -> Result<ApiResponse, ApiError> {
        let envelope = ApiRequest {
            header: Some(ApiRequestHeader { kicad_token: String::new(), client_name: self.client_name.clone() }),
            message: Some(Any::from_msg(request).map_err(|e| e.to_string())?),
        };
        let bytes = self.pipe.request(&envelope.encode_to_vec())?;
        let reply = ApiResponse::decode(bytes.as_slice()).map_err(|e| format!("reply to {}: {e}", R::NAME))?;
        match reply.status.as_ref().map(|s| (s.status(), s.error_message.clone())) {
            Some((ApiStatusCode::AsOk, _)) => Ok(reply),
            Some((status, message)) => Err(ApiError { status, message }),
            None => Err(ApiError::from(format!("no status in the reply to {}", R::NAME))),
        }
    }

    /// True once the server answers. A server that is still starting says AS_NOT_READY.
    pub fn ping(&mut self) -> Result<(), ApiError> {
        self.exchange(&Ping {}).map(|_| ())
    }

    pub fn version(&mut self) -> Result<KiCadVersion, ApiError> {
        let reply: GetVersionResponse = self.call(&GetVersion {})?;
        reply.version.ok_or_else(|| ApiError::from("no version".to_string()))
    }

    /// The board the server has open.
    pub fn board_document(&mut self) -> Result<DocumentSpecifier, ApiError> {
        let reply: GetOpenDocumentsResponse = self.call(&GetOpenDocuments { r#type: DocumentType::DoctypePcb as i32 })?;
        reply.documents.into_iter().next().ok_or_else(|| ApiError::from("no board is open".to_string()))
    }

    /// Every item of these kinds, in the server's order. Items keep their protobuf type; `decode` opens them.
    pub fn items(&mut self, document: &DocumentSpecifier, kinds: &[KiCadObjectType]) -> Result<Vec<Any>, ApiError> {
        let header = ItemHeader { document: Some(document.clone()), container: None, field_mask: None };
        let reply: GetItemsResponse = self.call(&GetItems { header: Some(header), types: kinds.iter().map(|k| *k as i32).collect() })?;
        if reply.status() != ItemRequestStatus::IrsOk {
            return Err(ApiError::from(format!("GetItems: {}", reply.status().as_str_name())));
        }
        Ok(reply.items)
    }

    pub fn nets(&mut self, document: &DocumentSpecifier) -> Result<Vec<Net>, ApiError> {
        let reply: NetsResponse = self.call(&GetNets { board: Some(document.clone()), netclass_filter: Vec::new() })?;
        Ok(reply.nets)
    }
}

/// An item of `GetItems` as `T`, or None when it is another type.
pub fn decode<T: Name + Default>(item: &Any) -> Option<T> {
    item.to_msg().ok()
}
