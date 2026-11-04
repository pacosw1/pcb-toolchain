//! KiCad DRU conditions: parsed once, evaluated in three values (true, false, unknown) and never executed. The grammar is the
//! expression part of KiCad's rule language as Python reads it once `&&`, `||` and `!` are spelled out, so a condition is
//! unknown exactly when the router cannot decide it, never a guess.
use super::text::glob_match;

/// A condition. An unparsable text stays a Selector and evaluates to unknown.
#[derive(Debug, Clone, PartialEq)]
pub struct Selector {
    pub text: String,
    tokens: Vec<Token>,
    expr: Option<Expr>,
}

/// One side of a rule: what a selector can read of an item. `None` is an attribute the item does not have.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Item {
    pub net_name: Option<String>,
    pub net_class: Option<String>,
    pub item_type: Option<String>,
    pub pad_type: Option<String>,
    pub reference: Option<String>,
    pub pad_number: Option<String>,
    /// The diff pair of the net, by its positive net.
    pub pair: Option<String>,
    /// Values of the region atoms (`fn:arg`) that are known for this item.
    pub regions: Vec<(String, bool)>,
}

impl Item {
    /// A plain item as the per-net rules see it: no pad type, no footprint.
    pub fn plain(net: &str, class: &str, item_type: &str) -> Item {
        Item { net_name: Some(net.to_string()), net_class: Some(class.to_string()), item_type: Some(item_type.to_string()), pad_type: Some(String::new()), ..Item::default() }
    }

    /// The attribute a condition names.
    pub fn attr(&self, name: &str) -> Option<&str> {
        match name {
            "NetName" => self.net_name.as_deref(),
            "NetClass" => self.net_class.as_deref(),
            "Type" => self.item_type.as_deref(),
            "Pad_Type" => self.pad_type.as_deref(),
            "Reference" => self.reference.as_deref(),
            "Pad_Number" => self.pad_number.as_deref(),
            "Pair" => self.pair.as_deref(),
            _ => None,
        }
    }

    fn region(&self, key: &str) -> Option<bool> {
        self.regions.iter().find(|(k, _)| k == key).map(|(_, v)| *v)
    }
}

/// The two items of a test. `pair` turns on the functions only the pair rules can decide: a per-net rule leaves them unknown.
#[derive(Clone, Copy)]
pub struct Scope<'a> {
    pub a: &'a Item,
    pub b: &'a Item,
    pub pair: bool,
}

/// `A.attr == 'literal'` or `A.fn('arg')`: the atoms that make two items behave differently in a rule.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Atom {
    Compare { attr: String, literal: String },
    Call { function: String, arg: String },
}

/// The spatial selectors a region atom stands for.
pub const REGION_FUNCTIONS: [&str; 4] = ["intersectsCourtyard", "intersectsFrontCourtyard", "intersectsBackCourtyard", "intersectsArea"];

impl Atom {
    /// True, false, or None when the item cannot say. The item stands on both sides.
    pub fn value(&self, item: &Item) -> Option<bool> {
        let scope = Scope { a: item, b: item, pair: true };
        match self {
            Atom::Compare { attr, literal } => compare(Some(Value::Str(item.attr(attr)?.to_string())), literal, false),
            Atom::Call { function, arg } if arg.is_empty() => call(Side::A, function, &[], scope).as_bool(),
            Atom::Call { function, arg } => call(Side::A, function, &[Expr::Str(arg.clone())], scope).as_bool(),
        }
    }
}

/// What the condition reads that decides group identity: its atoms and the attributes it compares between items.
#[derive(Debug, Default, PartialEq)]
pub struct Reads {
    pub atoms: Vec<Atom>,
    pub compared: Vec<String>,
}

impl Selector {
    pub fn new(text: &str) -> Selector {
        let tokens = tokenize(text);
        let expr = Parser { tokens: &tokens, pos: 0 }.parse();
        Selector { text: text.to_string(), tokens, expr }
    }

    /// True, false, or None for unknown.
    pub fn eval(&self, scope: Scope) -> Option<bool> {
        self.expr.as_ref().map_or(Value::Unknown, |e| eval(e, scope)).as_bool()
    }

    /// A pair rule reads its second item: anything of B but its type, or an attribute of A against one of B.
    pub fn reads_both_items(&self) -> bool {
        let t = &self.tokens;
        let b_attr = |i: usize| matches!(&t[i..], [Token::Name(s), Token::Dot, Token::Name(attr), ..] if s == "B" && is_pair_attribute(attr));
        let a_vs_b = |i: usize| matches!(&t[i..], [Token::Name(a), Token::Dot, Token::Name(_), Token::Op(op), Token::Name(b), Token::Dot, Token::Name(_), ..] if a == "A" && b == "B" && (op == "==" || op == "!="));
        (0..t.len()).any(|i| b_attr(i) || a_vs_b(i))
    }

    /// True when the condition is exactly these tokens, ignoring spacing.
    pub fn is_spelled(&self, text: &str) -> bool {
        self.tokens == tokenize(text)
    }

    pub fn reads(&self) -> Reads {
        let mut reads = Reads::default();
        if let Some(e) = &self.expr {
            collect_reads(e, &mut reads);
        }
        reads
    }
}

fn is_pair_attribute(attr: &str) -> bool {
    matches!(attr, "NetClass" | "NetName" | "Net" | "Reference" | "Pad_Number" | "Pad_Type" | "memberOfFootprint" | "enclosedByArea" | "hasNetclass")
        || attr.starts_with("intersects")
        || attr.starts_with("inside")
}

fn collect_reads(e: &Expr, out: &mut Reads) {
    match e {
        Expr::Not(x) => collect_reads(x, out),
        Expr::And(xs) | Expr::Or(xs) => xs.iter().for_each(|x| collect_reads(x, out)),
        Expr::Compare { left, right, .. } => match (&**left, &**right) {
            (Expr::Attr(_, l), Expr::Attr(_, r)) => out.compared.extend([l.clone(), r.clone()]),
            (Expr::Attr(_, attr), Expr::Str(literal)) => out.atoms.push(Atom::Compare { attr: attr.clone(), literal: literal.clone() }),
            _ => {}
        },
        Expr::Call(_, f, _) if f == "isCoupledDiffPair" => out.compared.push("Pair".to_string()),
        Expr::Call(_, f, args) if args.is_empty() || string_arg(args).is_some() => out.atoms.push(Atom::Call { function: f.clone(), arg: string_arg(args).unwrap_or("").to_string() }),
        _ => {}
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Side {
    A,
    B,
}

#[derive(Debug, Clone, PartialEq)]
enum Expr {
    Bool(bool),
    Str(String),
    Attr(Side, String),
    Not(Box<Expr>),
    And(Vec<Expr>),
    Or(Vec<Expr>),
    Compare { left: Box<Expr>, equal: bool, right: Box<Expr> },
    Call(Side, String, Vec<Expr>),
    /// Valid but not a form selectors decide: `<`, arithmetic, numbers, a call of something else.
    Other,
}

enum Value {
    Bool(bool),
    Str(String),
    Unknown,
}

impl Value {
    fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }
}

fn eval(e: &Expr, s: Scope) -> Value {
    match e {
        Expr::Bool(b) => Value::Bool(*b),
        Expr::Str(t) => Value::Str(t.clone()),
        Expr::Attr(side, name) => item(*side, s).attr(name).map_or(Value::Unknown, |v| Value::Str(v.to_string())),
        Expr::Not(x) => match eval(x, s) {
            Value::Bool(b) => Value::Bool(!b),
            Value::Str(t) => Value::Bool(t.is_empty()),
            Value::Unknown => Value::Unknown,
        },
        Expr::And(xs) => fold(xs, s, false),
        Expr::Or(xs) => fold(xs, s, true),
        Expr::Compare { left, equal, right } => eval_compare(left, *equal, right, s),
        Expr::Call(side, f, args) => call(*side, f, args, s),
        Expr::Other => Value::Unknown,
    }
}

/// `and` and `or`: `decider` settles the result, an unknown blocks the other outcome.
fn fold(xs: &[Expr], s: Scope, decider: bool) -> Value {
    let values: Vec<Option<bool>> = xs.iter().map(|x| eval(x, s).as_bool()).collect();
    if values.contains(&Some(decider)) {
        Value::Bool(decider)
    } else if values.contains(&None) {
        Value::Unknown
    } else {
        Value::Bool(!decider)
    }
}

fn eval_compare(left: &Expr, equal: bool, right: &Expr, s: Scope) -> Value {
    if let (Expr::Attr(ls, l), Expr::Attr(rs, r), true) = (left, right, s.pair) {
        return match (item(*ls, s).attr(l), item(*rs, s).attr(r)) {
            (Some(x), Some(y)) => Value::Bool((x == y) == equal),
            _ => Value::Unknown,
        };
    }
    let (attr, literal) = match (left, right) {
        (Expr::Attr(..), Expr::Str(lit)) => (left, lit),
        (Expr::Str(lit), Expr::Attr(..)) => (right, lit),
        _ => return Value::Unknown,
    };
    compare(Some(eval(attr, s)), literal, !equal).map_or(Value::Unknown, Value::Bool)
}

/// KiCad rule strings compare with wildcards. A bracket in the literal is not one of KiCad's: unknown.
fn compare(value: Option<Value>, literal: &str, negate: bool) -> Option<bool> {
    if literal.contains(['[', ']']) {
        return None;
    }
    match value? {
        Value::Str(v) => Some(glob_match(&v, literal) != negate),
        _ => None,
    }
}

fn item(side: Side, s: Scope<'_>) -> &Item {
    match side {
        Side::A => s.a,
        Side::B => s.b,
    }
}

fn string_arg(args: &[Expr]) -> Option<&str> {
    match args {
        [Expr::Str(a)] => Some(a),
        _ => None,
    }
}

fn call(side: Side, function: &str, args: &[Expr], s: Scope) -> Value {
    if s.pair
        && let Some(decided) = pair_function(side, function, args, s)
    {
        return decided;
    }
    if function == "inDiffPair" {
        return in_diff_pair(item(side, s), string_arg(args));
    }
    Value::Unknown
}

/// The functions a pair rule can decide from item attributes; None leaves the call to the plain rules. An empty argument or
/// no argument both read as ''.
fn pair_function(side: Side, function: &str, args: &[Expr], s: Scope) -> Option<Value> {
    if args.len() > 1 || (args.len() == 1 && string_arg(args).is_none()) {
        return None;
    }
    let arg = string_arg(args).unwrap_or("");
    let it = item(side, s);
    Some(Value::Bool(match function {
        "memberOfFootprint" => it.reference.as_deref().is_some_and(|r| !r.is_empty() && glob_match(r, arg)),
        "isCoupledDiffPair" => s.a.pair.as_deref().is_some_and(|p| !p.is_empty()) && s.a.pair == s.b.pair && s.a.net_name != s.b.net_name,
        "hasNetclass" => it.net_class.as_deref().is_some_and(|c| glob_match(c, arg)),
        f if is_region_function(f) => return it.region(&format!("{f}:{arg}")).map(Value::Bool),
        _ => return None,
    }))
}

fn is_region_function(f: &str) -> bool {
    REGION_FUNCTIONS.contains(&f) || f.starts_with("inside") || f == "enclosedByArea"
}

/// A wildcard base is unknown; an item with no net name is in no pair.
fn in_diff_pair(it: &Item, base: Option<&str>) -> Value {
    let Some(base) = base.filter(|b| !b.contains(['*', '?', '['])) else { return Value::Unknown };
    let name = it.net_name.as_deref().unwrap_or("");
    let member = it.net_name.is_some() && ["_P", "_N", "+", "-", "P", "N"].iter().any(|s| name.strip_prefix(base) == Some(s));
    Value::Bool(member)
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Name(String),
    Str(String),
    Number,
    Dot,
    Open,
    Close,
    Comma,
    Op(String),
    /// A line break outside parentheses, or text no expression has.
    Invalid,
}

const KEYWORD_OPERATORS: [&str; 5] = ["and", "or", "not", "in", "is"];

fn tokenize(text: &str) -> Vec<Token> {
    let chars: Vec<char> = text.trim().chars().collect();
    let mut out = Vec::new();
    let (mut i, mut depth) = (0, 0i32);
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\n' if depth == 0 => {
                out.push(Token::Invalid);
                i += 1;
            }
            c if c.is_whitespace() => i += 1,
            '\'' | '"' => {
                let (literal, end) = string_literal(&chars, i);
                out.push(literal.map_or(Token::Invalid, Token::Str));
                i = end;
            }
            '(' => {
                depth += 1;
                out.push(Token::Open);
                i += 1;
            }
            ')' => {
                depth -= 1;
                out.push(Token::Close);
                i += 1;
            }
            ',' => {
                out.push(Token::Comma);
                i += 1;
            }
            '.' if !chars.get(i + 1).is_some_and(char::is_ascii_digit) => {
                out.push(Token::Dot);
                i += 1;
            }
            c if c.is_ascii_digit() || c == '.' => {
                let (token, end) = number(&chars, i);
                out.push(token);
                i = end;
            }
            c if c.is_alphabetic() || c == '_' => {
                let end = (i..chars.len()).find(|&j| !(chars[j].is_alphanumeric() || chars[j] == '_')).unwrap_or(chars.len());
                let word: String = chars[i..end].iter().collect();
                // A name right before a quote would be a string prefix: not in the language.
                let prefix = matches!(chars.get(end), Some('\'' | '"'));
                out.push(if prefix { Token::Invalid } else { Token::Name(word) });
                i = end;
            }
            _ => {
                let (op, len) = operator(&chars[i..]);
                out.push(op);
                i += len;
            }
        }
    }
    out
}

/// A number, with no unit: `0.2mm` is not an expression.
fn number(chars: &[char], start: usize) -> (Token, usize) {
    let is_body = |c: char| c.is_alphanumeric() || c == '.' || c == '_';
    let end = (start..chars.len()).find(|&j| !is_body(chars[j])).unwrap_or(chars.len());
    let valid = chars[start..end].iter().all(|c| c.is_ascii_digit() || *c == '.') && chars[start..end].iter().filter(|c| **c == '.').count() <= 1;
    (if valid { Token::Number } else { Token::Invalid }, end)
}

/// The text of a quoted literal and the index after it; None when it does not close.
fn string_literal(chars: &[char], start: usize) -> (Option<String>, usize) {
    let quote = chars[start];
    let mut out = String::new();
    let mut i = start + 1;
    while i < chars.len() {
        match chars[i] {
            c if c == quote => return (Some(out), i + 1),
            '\n' => break,
            '\\' if i + 1 < chars.len() => {
                out.push(chars[i + 1]);
                i += 2;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    (None, chars.len())
}

fn operator(rest: &[char]) -> (Token, usize) {
    let two: String = rest.iter().take(2).collect();
    match two.as_str() {
        "&&" | "||" | "==" | "!=" | "<=" | ">=" => return (Token::Op(two), 2),
        _ => {}
    }
    match rest[0] {
        c @ ('!' | '<' | '>' | '+' | '-' | '*' | '/' | '%') => (Token::Op(c.to_string()), 1),
        _ => (Token::Invalid, 1),
    }
}

struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
}

impl Parser<'_> {
    fn parse(mut self) -> Option<Expr> {
        let e = self.or()?;
        (self.pos == self.tokens.len()).then_some(e)
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn take(&mut self, token: &Token) -> bool {
        let found = self.peek() == Some(token);
        self.pos += usize::from(found);
        found
    }

    fn take_word(&mut self, symbol: &str, keyword: &str) -> bool {
        let found = match self.peek() {
            Some(Token::Op(op)) => op == symbol,
            Some(Token::Name(n)) => n == keyword,
            _ => false,
        };
        self.pos += usize::from(found);
        found
    }

    fn or(&mut self) -> Option<Expr> {
        let first = self.and()?;
        let mut all = vec![first];
        while self.take_word("||", "or") {
            all.push(self.and()?);
        }
        Some(if all.len() == 1 { all.remove(0) } else { Expr::Or(all) })
    }

    fn and(&mut self) -> Option<Expr> {
        let first = self.not()?;
        let mut all = vec![first];
        while self.take_word("&&", "and") {
            all.push(self.not()?);
        }
        Some(if all.len() == 1 { all.remove(0) } else { Expr::And(all) })
    }

    fn not(&mut self) -> Option<Expr> {
        if self.take_word("!", "not") {
            return Some(Expr::Not(Box::new(self.not()?)));
        }
        self.comparison()
    }

    fn comparison(&mut self) -> Option<Expr> {
        let left = self.arithmetic()?;
        let mut ops = Vec::new();
        let mut rights = Vec::new();
        while let Some(op) = self.comparison_op() {
            ops.push(op);
            rights.push(self.arithmetic()?);
        }
        Some(match (ops.as_slice(), rights.pop()) {
            ([], _) => left,
            ([op @ ("==" | "!=")], Some(right)) => Expr::Compare { left: Box::new(left), equal: *op == "==", right: Box::new(right) },
            _ => Expr::Other,
        })
    }

    fn comparison_op(&mut self) -> Option<&'static str> {
        let op = match self.peek()? {
            Token::Op(op) => ["==", "!=", "<", ">", "<=", ">="].into_iter().find(|o| o == op)?,
            Token::Name(n) if n == "in" || n == "is" => "in",
            _ => return None,
        };
        self.pos += 1;
        Some(op)
    }

    fn arithmetic(&mut self) -> Option<Expr> {
        let first = self.unary()?;
        let mut other = false;
        while matches!(self.peek(), Some(Token::Op(op)) if matches!(op.as_str(), "+" | "-" | "*" | "/" | "%")) {
            self.pos += 1;
            self.unary()?;
            other = true;
        }
        Some(if other { Expr::Other } else { first })
    }

    fn unary(&mut self) -> Option<Expr> {
        if matches!(self.peek(), Some(Token::Op(op)) if op == "-" || op == "+") {
            self.pos += 1;
            self.unary()?;
            return Some(Expr::Other);
        }
        self.primary()
    }

    fn primary(&mut self) -> Option<Expr> {
        let token = self.peek()?.clone();
        self.pos += 1;
        let atom = match token {
            Token::Str(s) => self.adjacent_strings(s),
            Token::Number => Expr::Other,
            Token::Open => self.parenthesized()?,
            Token::Name(n) if KEYWORD_OPERATORS.contains(&n.as_str()) => return None,
            Token::Name(n) if n == "True" || n == "False" => Expr::Bool(n == "True"),
            Token::Name(n) => return self.trailers(&n),
            _ => return None,
        };
        self.after_atom(atom)
    }

    /// Python joins neighbouring literals.
    fn adjacent_strings(&mut self, mut text: String) -> Expr {
        while let Some(Token::Str(next)) = self.peek() {
            text.push_str(next);
            self.pos += 1;
        }
        Expr::Str(text)
    }

    fn parenthesized(&mut self) -> Option<Expr> {
        let inner = self.or()?;
        if self.take(&Token::Comma) {
            while !self.take(&Token::Close) {
                self.or()?;
                if !self.take(&Token::Comma) && self.peek() != Some(&Token::Close) {
                    return None;
                }
            }
            return Some(Expr::Other);
        }
        self.take(&Token::Close).then_some(inner)
    }

    /// An attribute or call on an atom that is not A or B parses, and decides nothing.
    fn after_atom(&mut self, atom: Expr) -> Option<Expr> {
        let mut e = atom;
        while matches!(self.peek(), Some(Token::Dot | Token::Open)) {
            self.trailer()?;
            e = Expr::Other;
        }
        Some(e)
    }

    /// The trailers after a name: `A.x`, `A.f('arg')`.
    fn trailers(&mut self, name: &str) -> Option<Expr> {
        let side = match name {
            "A" => Some(Side::A),
            "B" => Some(Side::B),
            _ => None,
        };
        let e = match side {
            Some(side) if self.peek() == Some(&Token::Dot) => {
                let attr = self.dotted()?;
                if self.take(&Token::Open) { Expr::Call(side, attr, self.arguments()?) } else { Expr::Attr(side, attr) }
            }
            _ => Expr::Other,
        };
        self.after_atom(e)
    }

    fn dotted(&mut self) -> Option<String> {
        self.pos += 1;
        match self.peek()?.clone() {
            Token::Name(n) => {
                self.pos += 1;
                Some(n)
            }
            _ => None,
        }
    }

    fn trailer(&mut self) -> Option<()> {
        if self.take(&Token::Open) {
            self.arguments().map(|_| ())
        } else {
            self.dotted().map(|_| ())
        }
    }

    fn arguments(&mut self) -> Option<Vec<Expr>> {
        let mut args = Vec::new();
        while !self.take(&Token::Close) {
            args.push(self.or()?);
            if !self.take(&Token::Comma) && self.peek() != Some(&Token::Close) {
                return None;
            }
        }
        Some(args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(net: &str, class: &str) -> Item {
        Item::plain(net, class, "Track")
    }

    fn plain(text: &str, a: &Item, b: &Item) -> Option<bool> {
        Selector::new(text).eval(Scope { a, b, pair: false })
    }

    fn pair(text: &str, a: &Item, b: &Item) -> Option<bool> {
        Selector::new(text).eval(Scope { a, b, pair: true })
    }

    #[test]
    fn compares_read_wildcards_both_ways_round() {
        let a = track("/USB_D+", "HS");
        let none = Item::default();
        assert_eq!(plain("A.NetName == '/USB*'", &a, &none), Some(true));
        assert_eq!(plain("'/USB*' == A.NetName", &a, &none), Some(true));
        assert_eq!(plain("A.NetClass != 'HS'", &a, &none), Some(false));
        assert_eq!(plain("A.Type == 'Track' && !(A.NetClass == 'X')", &a, &none), Some(true));
    }

    #[test]
    fn an_unknown_side_blocks_only_what_it_can_change() {
        let a = track("n", "C");
        let none = Item::default();
        assert_eq!(plain("B.NetClass == 'X'", &a, &none), None);
        assert_eq!(plain("A.NetClass == 'X' && B.NetClass == 'Y'", &a, &none), Some(false));
        assert_eq!(plain("A.NetClass == 'C' && B.NetClass == 'Y'", &a, &none), None);
        assert_eq!(plain("A.NetClass == 'C' || B.NetClass == 'Y'", &a, &none), Some(true));
        assert_eq!(plain("!(B.NetClass == 'Y')", &a, &none), None);
    }

    #[test]
    fn operators_inside_a_literal_are_text() {
        let a = track("a&&b", "C");
        assert_eq!(plain("A.NetName == 'a&&b'", &a, &Item::default()), Some(true));
    }

    #[test]
    fn a_bracket_in_a_literal_is_unknown() {
        assert_eq!(plain("A.NetName == 'D[0]'", &track("D0", "C"), &Item::default()), None);
    }

    #[test]
    fn a_form_outside_the_language_is_unknown() {
        let (a, none) = (track("n", "C"), Item::default());
        for text in ["A.Width > 0.2mm", "A.existsOnLayer('F.Cu')", "A.x ==", "", "1 + 1", "A.NetName == 'n' == 'n'", "A.NetName < 'n'", "A.NetName && B"] {
            assert_eq!(plain(text, &a, &none), None, "{text}");
        }
    }

    #[test]
    fn a_valid_form_it_cannot_decide_still_loses_to_a_false() {
        let (a, none) = (track("n", "C"), Item::default());
        assert_eq!(plain("A.NetClass == 'X' && A.Width > 1", &a, &none), Some(false));
        assert_eq!(plain("A.NetClass == 'X' && A.Width > 1mm", &a, &none), None);
    }

    #[test]
    fn a_line_break_outside_parentheses_is_not_an_expression() {
        let (a, none) = (track("n", "C"), Item::default());
        assert_eq!(plain("A.NetClass == 'C' &&\n A.Type == 'Track'", &a, &none), None);
        assert_eq!(plain("(A.NetClass == 'C' &&\n A.Type == 'Track')", &a, &none), Some(true));
    }

    #[test]
    fn in_diff_pair_takes_the_six_suffixes_of_a_plain_base() {
        let (p, none) = (track("/USB_P", "C"), Item::default());
        assert_eq!(plain("A.inDiffPair('/USB')", &p, &none), Some(true));
        assert_eq!(plain("A.inDiffPair('/US')", &p, &none), Some(false));
        assert_eq!(plain("A.inDiffPair('/USB*')", &p, &none), None);
        assert_eq!(plain("B.inDiffPair('/USB')", &p, &none), Some(false));
    }

    #[test]
    fn footprint_and_class_functions_need_the_pair_scope() {
        let mut a = track("n", "ISO");
        a.reference = Some("U22".to_string());
        let b = track("m", "OTH");
        assert_eq!(plain("A.memberOfFootprint('U*')", &a, &b), None);
        assert_eq!(pair("A.memberOfFootprint('U*')", &a, &b), Some(true));
        assert_eq!(pair("B.memberOfFootprint('U*')", &a, &b), Some(false));
        assert_eq!(pair("A.hasNetclass('IS?')", &a, &b), Some(true));
    }

    #[test]
    fn regions_are_known_only_where_the_item_says() {
        let mut a = track("n", "C");
        a.regions = vec![("intersectsArea:X".to_string(), true)];
        let b = track("m", "C");
        assert_eq!(pair("A.intersectsArea('X')", &a, &b), Some(true));
        assert_eq!(pair("B.intersectsArea('X')", &a, &b), None);
    }

    #[test]
    fn attribute_to_attribute_is_exact_and_pair_only() {
        let (a, b) = (track("n", "K1"), track("m", "K*"));
        assert_eq!(pair("A.NetClass != B.NetClass", &a, &b), Some(true));
        assert_eq!(plain("A.NetClass != B.NetClass", &a, &b), None);
        assert_eq!(pair("A.Reference == B.NetClass", &a, &b), None);
    }

    #[test]
    fn coupled_pair_needs_the_same_pair_and_two_nets() {
        let (mut p, mut n) = (track("P", "C"), track("N", "C"));
        p.pair = Some("P".to_string());
        n.pair = Some("P".to_string());
        assert_eq!(pair("A.isCoupledDiffPair()", &p, &n), Some(true));
        assert_eq!(pair("A.isCoupledDiffPair()", &p, &p), Some(false));
        assert_eq!(pair("A.isCoupledDiffPair()", &p, &track("X", "C")), Some(false));
    }

    #[test]
    fn a_pair_rule_is_one_that_reads_b() {
        for text in ["A.NetClass == 'X' && B.NetClass != 'X'", "B.memberOfFootprint('U1')", "B.intersectsCourtyard('J1')", "A.NetClass != B.NetClass"] {
            assert!(Selector::new(text).reads_both_items(), "{text}");
        }
        for text in ["A.isCoupledDiffPair()", "A.Type == 'Track' && B.Type == 'Zone'", "A.NetName == 'B.NetName'"] {
            assert!(!Selector::new(text).reads_both_items(), "{text}");
        }
    }

    #[test]
    fn spelling_ignores_only_spacing() {
        let s = Selector::new("A.Pad_Type=='Through-hole'  ||  B.Pad_Type == 'Through-hole'");
        assert!(s.is_spelled("A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"));
        assert!(!s.is_spelled("A.Pad_Type == 'Through-hole' && B.Pad_Type == 'Through-hole'"));
    }

    #[test]
    fn reads_lists_atoms_and_compared_attributes() {
        let r = Selector::new("A.NetClass == 'K' && A.NetClass != B.NetClass && !B.memberOfFootprint('U1') || A.isCoupledDiffPair()").reads();
        assert_eq!(r.atoms, [Atom::Compare { attr: "NetClass".to_string(), literal: "K".to_string() }, Atom::Call { function: "memberOfFootprint".to_string(), arg: "U1".to_string() }]);
        assert_eq!(r.compared, ["NetClass", "NetClass", "Pair"]);
    }

    #[test]
    fn an_atom_has_a_value_per_item() {
        let mut a = track("n", "K1");
        a.reference = Some("U1".to_string());
        assert_eq!(Atom::Compare { attr: "NetClass".to_string(), literal: "K*".to_string() }.value(&a), Some(true));
        assert_eq!(Atom::Compare { attr: "Layer".to_string(), literal: "F.Cu".to_string() }.value(&a), None);
        assert_eq!(Atom::Call { function: "memberOfFootprint".to_string(), arg: "U2".to_string() }.value(&a), Some(false));
        assert_eq!(Atom::Call { function: "intersectsArea".to_string(), arg: "X".to_string() }.value(&a), None);
    }
}
