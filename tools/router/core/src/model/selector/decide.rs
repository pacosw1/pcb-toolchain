//! Running a condition the way the rule compiler reads it: left to right with short circuits, comparing strings as wildcards
//! both ways round, and stopping at the first term a side cannot answer. `Selector::eval` is the three-valued reading that
//! decides admission; this one decides what a Fastroute model gets, and it keeps the name of the term that stopped it.
use super::{Expr, Selector, Side, Token};
use crate::model::text::glob_match;

/// One side of a rule condition. Only NetClass, NetName, Type and inDiffPair can be answered.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Decider<'a> {
    pub net: Option<&'a str>,
    pub class: Option<&'a str>,
    pub kind: Option<&'a str>,
}

/// Why a condition stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    /// A term no side can answer.
    Unsupported(String),
    /// Text that cannot run, with the reason.
    Unreadable(String),
}

#[derive(Debug, Clone, PartialEq)]
enum Value {
    Bool(bool),
    Text(String),
    /// A rule string: it compares with wildcards.
    Glob(String),
    /// `A.inDiffPair`, not called.
    Function,
}

impl Value {
    fn truth(&self) -> bool {
        match self {
            Value::Bool(flag) => *flag,
            Value::Text(text) | Value::Glob(text) => !text.is_empty(),
            Value::Function => true,
        }
    }

    fn text(&self) -> String {
        match self {
            Value::Bool(flag) => if *flag { "True" } else { "False" }.to_string(),
            Value::Text(text) | Value::Glob(text) => text.clone(),
            Value::Function => "<function>".to_string(),
        }
    }
}

fn equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Glob(_), _) | (_, Value::Glob(_)) => {
            let (a, b) = (left.text(), right.text());
            glob_match(&a, &b) || glob_match(&b, &a)
        }
        _ => left == right,
    }
}

struct Sides<'a> {
    a: Decider<'a>,
    b: Decider<'a>,
    tokens: &'a [Token],
}

impl Sides<'_> {
    fn side(&self, side: Side) -> Decider<'_> {
        match side {
            Side::A => self.a,
            Side::B => self.b,
        }
    }

    fn known(&self, side: Side, name: &str) -> Option<Value> {
        let item = self.side(side);
        let text = match name {
            "NetClass" => item.class,
            "NetName" => item.net,
            "Type" => item.kind,
            "inDiffPair" => return item.net.map(|_| Value::Function),
            _ => None,
        };
        text.map(|value| Value::Glob(value.to_string()))
    }

    fn attribute(&self, side: Side, name: &str) -> Result<Value, Stop> {
        self.known(side, name).ok_or_else(|| Stop::Unsupported(name.to_string()))
    }

    fn value(&self, e: &Expr) -> Result<Value, Stop> {
        Ok(match e {
            Expr::Bool(flag) => Value::Bool(*flag),
            Expr::Str(text) => Value::Text(text.clone()),
            Expr::Attr(side, name) => self.attribute(*side, name)?,
            Expr::Not(inner) => Value::Bool(!self.value(inner)?.truth()),
            Expr::And(items) => self.chain(items, false)?,
            Expr::Or(items) => self.chain(items, true)?,
            Expr::Compare { left, equal: wanted, right } => {
                let (l, r) = (self.value(left)?, self.value(right)?);
                Value::Bool(equal(&l, &r) == *wanted)
            }
            Expr::Call(side, name, args) => self.call(*side, name, args)?,
            Expr::Other => return Err(self.outside_the_subset()),
        })
    }

    /// `and` and `or`: the first value of truth `decider` ends it, else the last value stands.
    fn chain(&self, items: &[Expr], decider: bool) -> Result<Value, Stop> {
        let mut last = Value::Bool(!decider);
        for item in items {
            last = self.value(item)?;
            if last.truth() == decider {
                break;
            }
        }
        Ok(last)
    }

    fn call(&self, side: Side, name: &str, args: &[Expr]) -> Result<Value, Stop> {
        let function = self.attribute(side, name)?;
        if function != Value::Function {
            return Err(Stop::Unreadable("'Glob' object is not callable".to_string()));
        }
        let [arg] = args else {
            return Err(Stop::Unreadable(format!("<lambda>() takes 1 positional argument but {} were given", args.len())));
        };
        let base = match self.value(arg)? {
            Value::Text(text) | Value::Glob(text) => text,
            _ => return Err(Stop::Unreadable("unsupported operand type(s) for +".to_string())),
        };
        let net = self.side(side).net.unwrap_or("");
        Ok(Value::Bool(["_P", "_N", "+", "-", "P", "N"].iter().any(|suffix| net.strip_prefix(base.as_str()) == Some(suffix))))
    }

    /// A form the selector parser keeps no terms of: `<`, arithmetic, a bare name. The first unanswerable term in it is the
    /// one to name; with none, it is not a form this reading runs.
    fn outside_the_subset(&self) -> Stop {
        for window in self.tokens.windows(3) {
            if let [Token::Name(owner), Token::Dot, Token::Name(attr)] = window {
                let side = match owner.as_str() {
                    "A" => Side::A,
                    "B" => Side::B,
                    _ => continue,
                };
                if self.known(side, attr).is_none() {
                    return Stop::Unsupported(attr.clone());
                }
            }
        }
        Stop::Unreadable("expression outside the rule language".to_string())
    }
}

impl Selector {
    /// True or false for the two sides, or why the condition could not be run.
    pub fn decide(&self, a: Decider, b: Decider) -> Result<bool, Stop> {
        let expr = self.expr.as_ref().ok_or_else(|| Stop::Unreadable("invalid syntax (<string>, line 1)".to_string()))?;
        Ok(Sides { a, b, tokens: &self.tokens }.value(expr)?.truth())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(net: &str, class: &str) -> Decider<'static> {
        Decider { net: Some(Box::leak(net.to_string().into_boxed_str())), class: Some(Box::leak(class.to_string().into_boxed_str())), kind: Some("Track") }
    }

    fn run(text: &str, a: Decider) -> Result<bool, Stop> {
        Selector::new(text).decide(a, Decider::default())
    }

    #[test]
    fn a_false_left_side_hides_a_term_that_cannot_be_answered() {
        let a = track("n", "C");
        assert_eq!(run("A.NetClass == 'X' and A.intersectsArea('Z')", a), Ok(false));
        assert_eq!(run("A.NetClass == 'C' or A.intersectsArea('Z')", a), Ok(true));
        assert_eq!(run("A.NetClass == 'C' and A.intersectsArea('Z')", a), Err(Stop::Unsupported("intersectsArea".to_string())));
        assert_eq!(run("A.NetClass == 'C' and B.NetClass == 'Z'", a), Err(Stop::Unsupported("NetClass".to_string())));
    }

    #[test]
    fn rule_strings_compare_as_wildcards_both_ways() {
        let a = track("/USB_D", "H*");
        assert_eq!(run("A.NetName == '/USB*'", a), Ok(true));
        assert_eq!(run("A.NetClass == 'HS'", a), Ok(true));
        assert_eq!(run("A.NetClass != 'HS'", a), Ok(false));
        assert_eq!(run("'x' == 'x*'", a), Ok(false));
    }

    #[test]
    fn in_diff_pair_needs_a_net_and_a_plain_argument() {
        let a = track("/USB_P", "C");
        assert_eq!(run("A.inDiffPair('/USB')", a), Ok(true));
        assert_eq!(run("A.inDiffPair('/US')", a), Ok(false));
        assert_eq!(run("B.inDiffPair('/USB')", a), Err(Stop::Unsupported("inDiffPair".to_string())));
        assert!(matches!(run("A.inDiffPair()", a), Err(Stop::Unreadable(_))));
        assert!(matches!(run("A.NetClass('x')", a), Err(Stop::Unreadable(_))));
    }

    #[test]
    fn text_that_cannot_run_says_so() {
        let a = track("n", "C");
        assert!(matches!(run("A.NetClass ==", a), Err(Stop::Unreadable(_))));
        assert!(matches!(run("unbound_name", a), Err(Stop::Unreadable(_))));
        assert_eq!(run("A.Width > 1", a), Err(Stop::Unsupported("Width".to_string())));
    }
}
