//! Replaces the literals in a command document, so a value never appears in a `Db` entry.

use mongodb::bson::{Bson, Document};

/// Replaces every literal in a command document with `"?"`, keeping field names and operators, for
/// the `statement` of a MongoDB `Db` entry (OpenTelemetry `db.query.text`). BSON values, dates and
/// binary data are literals too.
pub fn sanitize_document(document: &Document) -> Document {
    document.iter().map(|(name, value)| (name.clone(), sanitize(value))).collect()
}

fn sanitize(value: &Bson) -> Bson {
    match value {
        Bson::Document(document) => Bson::Document(sanitize_document(document)),
        Bson::Array(items) => Bson::Array(items.iter().map(sanitize).collect()),
        _ => Bson::String("?".into()),
    }
}

#[cfg(test)]
mod tests {
    use mongodb::bson::{DateTime, doc, oid::ObjectId};

    use super::*;

    #[test]
    fn keeps_names_and_operators_and_hides_every_value() {
        let command = doc! {
            "update": "documents",
            "updates": [{ "q": { "_id": ObjectId::new() }, "u": { "$set": { "name": "Ann", "profile.city": "York", "at": DateTime::now() } } }],
        };
        let text = serde_json::to_string(&sanitize_document(&command)).unwrap();
        assert_eq!(text, r#"{"update":"?","updates":[{"q":{"_id":"?"},"u":{"$set":{"name":"?","profile.city":"?","at":"?"}}}]}"#);
        assert!(!text.contains("Ann") && !text.contains("York"));
    }
}
