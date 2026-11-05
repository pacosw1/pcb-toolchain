//! A board file as text and forms, and the field lookups proposals share.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::decimal::Decimal;
use crate::error::{Result, invalid};
use crate::raw::{Body, Form, parse};

pub struct Board {
    pub text: String,
    pub root: Form,
}

impl Board {
    pub fn read(path: &Path) -> Result<Board> {
        Board::from_text(fs::read_to_string(path)?)
    }

    pub fn from_text(text: String) -> Result<Board> {
        let mut forms = parse(&text).or_else(invalid)?;
        match forms.pop() {
            Some(root) if forms.is_empty() && root.is("kicad_pcb") => Ok(Board { text, root }),
            _ => invalid("unexpected native board root"),
        }
    }

    /// The forms under the root.
    pub fn forms(&self) -> &[Form] {
        &self.root.items()[1..]
    }

    pub fn source(&self, form: &Form) -> &str {
        &self.text[form.span.clone()]
    }
}

/// A form as JSON, the shape that gets hashed: atoms are strings and lists are arrays.
pub fn form_value(form: &Form) -> Value {
    match &form.body {
        Body::Atom(text) => Value::String(text.clone()),
        Body::List(items) => Value::Array(items.iter().map(form_value).collect()),
    }
}

/// What follows the head of the one child called `name`. Two such children are ambiguous, so they are refused.
pub fn child<'a>(form: &'a Form, name: &str) -> Result<Option<&'a [Form]>> {
    let mut rows = form.items().iter().filter(|row| row.is(name));
    let first = rows.next();
    if rows.next().is_some() {
        return invalid(format!("ambiguous native field: {name}"));
    }
    Ok(first.map(|row| &row.items()[1..]))
}

/// The first value of the one child called `name`.
pub fn child_text<'a>(form: &'a Form, name: &str) -> Result<Option<&'a str>> {
    Ok(child(form, name)?.and_then(|values| values.first()?.atom()))
}

/// The atoms of a child, for fields such as `(layers "F.Cu" "B.Cu")`.
pub fn child_atoms<'a>(form: &'a Form, name: &str) -> Result<Vec<&'a str>> {
    Ok(child(form, name)?.map_or(Vec::new(), |values| values.iter().filter_map(Form::atom).collect()))
}

/// The `uuid` of a form, from the first such child.
pub fn uuid(form: &Form) -> Option<&str> {
    form.items().iter().find(|row| row.is("uuid"))?.text(1)
}

pub fn has_atom(form: &Form, atom: &str) -> bool {
    form.items().iter().any(|row| row.atom() == Some(atom))
}

/// True for a bare `locked` or a `(locked ...)` that does not say no.
pub fn locked(form: &Form) -> Result<bool> {
    let field = child_atoms(form, "locked")?;
    Ok(has_atom(form, "locked") || (child(form, "locked")?.is_some() && field != ["no"]))
}

pub type NativePoint = (Decimal, Decimal);

/// A two-dimensional field such as `(start x y)`.
pub fn point(form: &Form, field: &str) -> Result<NativePoint> {
    let values = child_atoms(form, field)?;
    let numbers: Option<Vec<Decimal>> = values.iter().map(|text| Decimal::parse(text)).collect();
    match numbers.as_deref() {
        Some([x, y]) => Ok((*x, *y)),
        _ => invalid("expected native two-dimensional point"),
    }
}

/// A footprint on the board.
pub struct Footprint<'a> {
    pub form: &'a Form,
    pub props: BTreeMap<String, String>,
    pub pose: [Decimal; 3],
    /// The hierarchical path, without a trailing slash.
    pub path: String,
}

pub fn footprints(board: &Board) -> Result<Vec<Footprint<'_>>> {
    board.forms().iter().filter(|form| form.is("footprint")).map(read_footprint).collect()
}

fn read_footprint(form: &Form) -> Result<Footprint<'_>> {
    let mut props = BTreeMap::new();
    for row in form.children("property") {
        let (name, value) = (row.text(1).unwrap_or(""), row.text(2).unwrap_or(""));
        if props.insert(name.to_string(), value.to_string()).is_some() {
            return invalid("duplicate footprint property");
        }
    }
    let path = child_text(form, "path")?.unwrap_or("").trim_end_matches('/').to_string();
    Ok(Footprint { form, props, pose: read_pose(form)?, path })
}

fn read_pose(form: &Form) -> Result<[Decimal; 3]> {
    let values = child_atoms(form, "at")?;
    if !matches!(values.len(), 2 | 3) {
        return invalid("missing footprint pose");
    }
    let numbers: Option<Vec<Decimal>> = values.iter().map(|text| Decimal::parse(text)).collect();
    match numbers.as_deref() {
        Some([x, y]) => Ok([*x, *y, Decimal::ZERO]),
        Some([x, y, angle]) => Ok([*x, *y, *angle]),
        _ => invalid("nonfinite footprint pose"),
    }
}

/// KiCad's positive rotation is counterclockwise with Y pointing down.
pub fn rotate(x: Decimal, y: Decimal, quarters: u32) -> NativePoint {
    match quarters % 4 {
        0 => (x, y),
        1 => (y, Decimal::ZERO - x),
        2 => (Decimal::ZERO - x, Decimal::ZERO - y),
        _ => (Decimal::ZERO - y, x),
    }
}
