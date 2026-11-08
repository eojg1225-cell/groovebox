//! Reading the protocol's plain-data messages (serde_json values) the way the TypeScript does:
//! a missing or non-number field takes its default (`??`), maps keep their key order.

use serde_json::Value;

/// A number field, or None when missing / not a number (`x ?? d` reads as `num(x).unwrap_or(d)`).
pub fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

pub fn num_or(v: &Value, key: &str, d: f64) -> f64 {
    num(v, key).unwrap_or(d)
}

/// JavaScript truthiness of a field.
pub fn truthy(v: &Value, key: &str) -> bool {
    match v.get(key) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `x === true`.
pub fn is_true(v: &Value, key: &str) -> bool {
    matches!(v.get(key), Some(Value::Bool(true)))
}

pub fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// A Record<string, number> in key order (non-numbers left out).
pub fn record(v: Option<&Value>) -> Vec<(String, f64)> {
    match v {
        Some(Value::Object(m)) => m.iter().filter_map(|(k, x)| x.as_f64().map(|n| (k.clone(), n))).collect(),
        _ => Vec::new(),
    }
}

/// A value from a record by key.
pub fn lookup(rec: &[(String, f64)], id: &str) -> Option<f64> {
    rec.iter().find(|(k, _)| k == id).map(|(_, v)| *v)
}

pub fn arr(v: Option<&Value>) -> &[Value] {
    match v {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}
