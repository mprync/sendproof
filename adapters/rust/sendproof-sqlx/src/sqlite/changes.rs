//! Row-change capture for SQLite through the pre-update hook.

use std::{collections::HashMap, sync::Arc};

use serde_json::{Map, Value, json};
use sqlx::{
    Decode, Sqlite, SqliteConnection, TypeInfo, ValueRef,
    sqlite::{PreupdateHookResult, SqliteOperation, SqliteValueRef},
};
use sendproof_core::{limits, model::Change};

use crate::log::ChangeLog;

/// Column layout of one table.
struct Table {
    columns: Vec<String>,
    /// Indexes of the primary key columns, in key order.
    key: Vec<usize>,
}

/// Installs the hook on `connection`. Call [`remove`] before the connection returns to its pool.
pub(crate) async fn install(connection: &mut SqliteConnection, log: Arc<ChangeLog>) -> Result<(), sqlx::Error> {
    let schema = load_schema(connection).await?;
    let sink = log;
    connection.lock_handle().await?.set_preupdate_hook(move |event: PreupdateHookResult| {
        if let Some(change) = describe(&schema, &event) {
            sink.push(change);
        }
    });
    Ok(())
}

/// Removes the hook installed by [`install`].
pub(crate) async fn remove(connection: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    connection.lock_handle().await?.remove_preupdate_hook();
    Ok(())
}

async fn load_schema(connection: &mut SqliteConnection) -> Result<HashMap<String, Table>, sqlx::Error> {
    let names: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .fetch_all(&mut *connection)
        .await?;
    let mut schema = HashMap::new();
    for name in names {
        let rows: Vec<(String, i64)> =
            sqlx::query_as("SELECT name, pk FROM pragma_table_info(?1) ORDER BY cid").bind(&name).fetch_all(&mut *connection).await?;
        let columns: Vec<String> = rows.iter().map(|(column, _)| column.clone()).collect();
        let mut key: Vec<(i64, usize)> =
            rows.iter().enumerate().filter(|(_, (_, pk))| *pk > 0).map(|(index, (_, pk))| (*pk, index)).collect();
        key.sort();
        schema.insert(name, Table { columns, key: key.into_iter().map(|(_, index)| index).collect() });
    }
    Ok(schema)
}

fn describe(schema: &HashMap<String, Table>, event: &PreupdateHookResult<'_>) -> Option<Change> {
    let count = usize::try_from(event.get_column_count()).ok()?;
    let table = schema.get(event.table);
    let name = |index: usize| table.and_then(|t| t.columns.get(index).cloned()).unwrap_or_else(|| format!("column{index}"));
    let row = |old: bool| -> Option<Map<String, Value>> {
        let mut map = Map::new();
        for index in 0..count.min(limits::PARAMETERS) {
            let value = if old { event.get_old_column_value(index as i32) } else { event.get_new_column_value(index as i32) };
            map.insert(name(index), value.ok().map_or(Value::Null, value_json));
        }
        Some(map)
    };
    let (operation, before, after) = match event.operation {
        SqliteOperation::Insert => ("insert", None, row(false)),
        SqliteOperation::Update => ("update", row(true), row(false)),
        SqliteOperation::Delete => ("delete", row(true), None),
        SqliteOperation::Unknown(_) => return None,
    };
    let image = after.as_ref().or(before.as_ref())?;
    let key = match table {
        Some(table) if !table.key.is_empty() => {
            let mut key = Map::new();
            for &index in &table.key {
                let column = name(index);
                key.insert(column.clone(), image.get(&column).cloned().unwrap_or(Value::Null));
            }
            Value::Object(key)
        }
        _ => json!({ "rowid": event.get_new_row_id().or_else(|_| event.get_old_row_id()).ok() }),
    };
    Some(Change {
        operation: operation.to_owned(),
        table: event.table.to_owned(),
        key: Some(key),
        before: before.map(Value::Object),
        after: after.map(Value::Object),
        ..Change::default()
    })
}

fn value_json(value: SqliteValueRef<'_>) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    let kind = value.type_info().name().to_owned();
    match kind.as_str() {
        "INTEGER" | "BOOLEAN" => <i64 as Decode<Sqlite>>::decode(value).map_or(Value::Null, Value::from),
        "REAL" | "NUMERIC" => <f64 as Decode<Sqlite>>::decode(value).map_or(Value::Null, Value::from),
        "BLOB" => <Vec<u8> as Decode<Sqlite>>::decode(value).map_or(Value::Null, |bytes| {
            let shown = &bytes[..bytes.len().min(limits::TEXT / 2)];
            Value::String(shown.iter().map(|byte| format!("{byte:02x}")).collect())
        }),
        _ => <String as Decode<Sqlite>>::decode(value).map_or(Value::Null, |text| Value::String(limits::clip(&text, limits::TEXT))),
    }
}
