//! The guarded handles: [`MongoDatabase`] and [`MongoCollection`] carry the driver's methods, and
//! during a Preview each call is checked **before the driver builds a command**:
//!
//! * the Preview session is passed to the operation (`preview` mode), so the command carries the
//!   Preview's `lsid`, `txnNumber` and `autocommit: false` and rolls back with it;
//! * the guard classifies the command the method sends and blocks writes (`guard` mode) or what a
//!   transaction can't run (`preview` mode);
//! * a handle offers only the methods listed here, so a driver method this guard doesn't know can't be
//!   reached (fail closed).
//!
//! Outside a Preview every call passes straight through to the driver.

use std::{borrow::Borrow, sync::Arc};

use futures_util::TryStreamExt;
use mongodb::{
    ClientSession, Collection, Database, IndexModel,
    bson::{Bson, Document, doc},
    error::Error,
    options::{
        FindOneAndReplaceOptions, FindOneAndUpdateOptions, FindOneOptions, FindOptions, ReplaceOptions, UpdateModifications, UpdateOptions,
    },
    results::{CreateIndexResult, DeleteResult, InsertManyResult, InsertOneResult, UpdateResult},
};
use sendproof_core::stores::{CommandKind, StoreScope};
use serde::{Serialize, de::DeserializeOwned};
use tokio::sync::OwnedMutexGuard;

use crate::{
    classify::classify_mongo,
    engine::Engine,
    monitor::ends_transaction,
    preview::{Mode, PreviewState, refused_reason},
};

/// Commands on these databases can't join a transaction.
pub(crate) fn system_database(name: &str) -> bool {
    matches!(name, "admin" | "config" | "local")
}

/// The request-scoped parts every handle shares.
#[derive(Clone)]
pub(crate) struct Access {
    pub engine: Arc<Engine>,
    pub scope: StoreScope,
    /// The Preview's state on this store, when the request is a Preview. A Preview with no state here
    /// is treated as `guard` mode: it fails closed.
    pub state: Option<Arc<PreviewState>>,
}

/// The session an operation runs on, held for the whole operation.
type Session = Option<OwnedMutexGuard<ClientSession>>;

impl Access {
    /// Classifies a command before it is sent and lets the guard refuse it. In `guard` mode every write
    /// blocks; in `preview` mode only what MongoDB can't run inside a transaction does. The `admin`,
    /// `config` and `local` databases run outside the transaction, so their writes block too.
    fn check(&self, command: &Document, operation: &str, database: &str) -> Result<(), Error> {
        if !self.scope.in_preview() {
            return Ok(());
        }
        if ends_transaction(&operation.to_lowercase()) {
            let fault = self.scope.refuse(format!("Preview owns the MongoDB transaction, so the handler's {operation} cannot run during Preview."));
            return Err(Error::custom(fault));
        }
        let class = classify_mongo(command, Some(&self.engine.shared.reads));
        let joins = self.state.as_ref().is_some_and(|state| state.mode == Mode::Preview) && !system_database(database);
        if joins {
            if let Some(refused) = class.refused_in_transaction {
                self.scope.guard(crate::SYSTEM, operation, CommandKind::Write, Some(&refused_reason(&refused))).map_err(Error::custom)?;
            }
            return Ok(());
        }
        self.scope.guard(crate::SYSTEM, operation, class.kind, None).map_err(Error::custom)
    }

    /// Guards a call and returns the session to run it on: the Preview's, held until the operation
    /// completes, or `None` outside a Preview, in `guard` mode and on system databases.
    async fn session(&self, command: Document, operation: &str, database: &str) -> Result<Session, Error> {
        self.check(&command, operation, database)?;
        let Some(state) = self.state.as_ref().filter(|state| state.mode == Mode::Preview && self.scope.in_preview()) else { return Ok(None) };
        if system_database(database) {
            return Ok(None);
        }
        let Some(session) = state.session.clone() else { return Ok(None) };
        let session = session.lock_owned().await;
        if state.data().finished {
            // The transaction was aborted (the time limit): a command now would run outside any transaction.
            let fault = self.scope.refuse("The Preview's MongoDB transaction has ended, so this call was refused.");
            return Err(Error::custom(fault));
        }
        Ok(Some(session))
    }
}

/// A database of a hooked client, for one request. Get it from [`Mongo`](crate::Mongo).
#[derive(Clone)]
pub struct MongoDatabase {
    pub(crate) access: Access,
    pub(crate) inner: Database,
}

impl MongoDatabase {
    /// The database's name.
    pub fn name(&self) -> &str {
        self.inner.name()
    }

    /// A collection of this database, with the driver's document type `T`.
    pub fn collection<T: Send + Sync>(&self, name: &str) -> MongoCollection<T> {
        MongoCollection { access: self.access.clone(), inner: self.inner.collection::<T>(name), database: self.inner.name().to_owned() }
    }

    /// Runs a command document. It is classified by its first key like every other call, so a write
    /// blocks a `guard`-mode Preview, and `commitTransaction` and `abortTransaction` are always
    /// refused: the Preview owns its transaction.
    pub async fn run_command(&self, command: Document) -> Result<Document, Error> {
        let operation = crate::classify::command_name(&command).to_owned();
        let mut session = self.access.session(command.clone(), &operation, self.inner.name()).await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.run_command(command).session(session).await,
            None => self.inner.run_command(command).await,
        }
    }

    /// Runs a database-level aggregation (`aggregate: 1`) and collects the results.
    pub async fn aggregate(&self, pipeline: impl IntoIterator<Item = Document>) -> Result<Vec<Document>, Error> {
        let pipeline: Vec<Document> = pipeline.into_iter().collect();
        let mut session = self.access.session(doc! { "aggregate": 1, "pipeline": pipeline.clone() }, "aggregate", self.inner.name()).await?;
        match session.as_deref_mut() {
            Some(session) => {
                let mut cursor = self.inner.aggregate(pipeline).session(&mut *session).await?;
                cursor.stream(session).try_collect().await
            }
            None => self.inner.aggregate(pipeline).await?.try_collect().await,
        }
    }

    /// The collection names. MongoDB refuses `listCollections` inside a transaction, so a Preview that
    /// calls this is blocked with that reason.
    pub async fn list_collection_names(&self) -> Result<Vec<String>, Error> {
        let mut session = self.access.session(doc! { "listCollections": 1 }, "listCollections", self.inner.name()).await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.list_collection_names().session(session).await,
            None => self.inner.list_collection_names().await,
        }
    }
}

/// A collection of a hooked client, for one request. Get it from [`MongoDatabase::collection`] or
/// [`Mongo::collection`](crate::Mongo::collection).
#[derive(Clone)]
pub struct MongoCollection<T: Send + Sync = Document> {
    access: Access,
    inner: Collection<T>,
    database: String,
}

impl<T: Send + Sync> MongoCollection<T> {
    fn name(&self) -> &str {
        self.inner.name()
    }

    /// Guards a call that sends `command`, and returns its session.
    async fn open(&self, command: Document, operation: &str) -> Result<Session, Error> {
        self.access.session(command, operation, &self.database).await
    }

    /// Finds the first document matching `filter`.
    pub async fn find_one(&self, filter: Document) -> Result<Option<T>, Error>
    where
        T: DeserializeOwned + Unpin,
    {
        self.find_one_with(filter, None).await
    }

    /// [`find_one`](Self::find_one) with options.
    pub async fn find_one_with(&self, filter: Document, options: impl Into<Option<FindOneOptions>>) -> Result<Option<T>, Error>
    where
        T: DeserializeOwned + Unpin,
    {
        let mut session = self.open(doc! { "find": self.name() }, "find").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.find_one(filter).with_options(options).session(session).await,
            None => self.inner.find_one(filter).with_options(options).await,
        }
    }

    /// Finds every document matching `filter` and collects them.
    pub async fn find(&self, filter: Document) -> Result<Vec<T>, Error>
    where
        T: DeserializeOwned + Unpin,
    {
        self.find_with(filter, None).await
    }

    /// [`find`](Self::find) with options (sort, limit, projection).
    pub async fn find_with(&self, filter: Document, options: impl Into<Option<FindOptions>>) -> Result<Vec<T>, Error>
    where
        T: DeserializeOwned + Unpin,
    {
        let mut session = self.open(doc! { "find": self.name() }, "find").await?;
        match session.as_deref_mut() {
            Some(session) => {
                let mut cursor = self.inner.find(filter).with_options(options).session(&mut *session).await?;
                cursor.stream(session).try_collect().await
            }
            None => self.inner.find(filter).with_options(options).await?.try_collect().await,
        }
    }

    /// Runs an aggregation and collects the results. A `$out` or `$merge` stage, at any depth, is a
    /// write: it blocks a `guard`-mode Preview, and MongoDB can't run it inside a transaction, so a
    /// `preview`-mode Preview is blocked before it is sent.
    pub async fn aggregate(&self, pipeline: impl IntoIterator<Item = Document>) -> Result<Vec<Document>, Error> {
        let pipeline: Vec<Document> = pipeline.into_iter().collect();
        let mut session = self.open(doc! { "aggregate": self.name(), "pipeline": pipeline.clone() }, "aggregate").await?;
        match session.as_deref_mut() {
            Some(session) => {
                let mut cursor = self.inner.aggregate(pipeline).session(&mut *session).await?;
                cursor.stream(session).try_collect().await
            }
            None => self.inner.aggregate(pipeline).await?.try_collect().await,
        }
    }

    /// Counts the documents matching `filter` (an aggregation, which a transaction allows).
    pub async fn count_documents(&self, filter: Document) -> Result<u64, Error> {
        let mut session = self.open(doc! { "aggregate": self.name(), "pipeline": [] }, "aggregate").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.count_documents(filter).session(session).await,
            None => self.inner.count_documents(filter).await,
        }
    }

    /// The estimated document count. It sends `count`, which MongoDB refuses inside a transaction, so
    /// a `preview`-mode Preview that calls it is blocked with that reason.
    pub async fn estimated_document_count(&self) -> Result<u64, Error> {
        self.open(doc! { "count": self.name() }, "count").await?;
        self.inner.estimated_document_count().await
    }

    /// The distinct values of `field` among the documents matching `filter`.
    pub async fn distinct(&self, field: &str, filter: Document) -> Result<Vec<Bson>, Error> {
        let mut session = self.open(doc! { "distinct": self.name() }, "distinct").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.distinct(field, filter).session(session).await,
            None => self.inner.distinct(field, filter).await,
        }
    }

    /// Inserts one document.
    pub async fn insert_one(&self, document: impl Borrow<T>) -> Result<InsertOneResult, Error>
    where
        T: Serialize,
    {
        let mut session = self.open(doc! { "insert": self.name() }, "insert").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.insert_one(document).session(session).await,
            None => self.inner.insert_one(document).await,
        }
    }

    /// Inserts many documents.
    pub async fn insert_many<D: Borrow<T>>(&self, documents: impl IntoIterator<Item = D>) -> Result<InsertManyResult, Error>
    where
        T: Serialize,
    {
        let mut session = self.open(doc! { "insert": self.name() }, "insert").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.insert_many(documents).session(session).await,
            None => self.inner.insert_many(documents).await,
        }
    }

    /// Updates the first document matching `filter`.
    pub async fn update_one(&self, filter: Document, update: impl Into<UpdateModifications>) -> Result<UpdateResult, Error> {
        self.update_one_with(filter, update, None).await
    }

    /// [`update_one`](Self::update_one) with options (`upsert`).
    pub async fn update_one_with(&self, filter: Document, update: impl Into<UpdateModifications>, options: impl Into<Option<UpdateOptions>>) -> Result<UpdateResult, Error> {
        let mut session = self.open(doc! { "update": self.name() }, "update").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.update_one(filter, update).with_options(options).session(session).await,
            None => self.inner.update_one(filter, update).with_options(options).await,
        }
    }

    /// Updates every document matching `filter`.
    pub async fn update_many(&self, filter: Document, update: impl Into<UpdateModifications>) -> Result<UpdateResult, Error> {
        self.update_many_with(filter, update, None).await
    }

    /// [`update_many`](Self::update_many) with options (`upsert`).
    pub async fn update_many_with(&self, filter: Document, update: impl Into<UpdateModifications>, options: impl Into<Option<UpdateOptions>>) -> Result<UpdateResult, Error> {
        let mut session = self.open(doc! { "update": self.name() }, "update").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.update_many(filter, update).with_options(options).session(session).await,
            None => self.inner.update_many(filter, update).with_options(options).await,
        }
    }

    /// Replaces the first document matching `filter`.
    pub async fn replace_one(&self, filter: Document, replacement: impl Borrow<T>) -> Result<UpdateResult, Error>
    where
        T: Serialize,
    {
        self.replace_one_with(filter, replacement, None).await
    }

    /// [`replace_one`](Self::replace_one) with options (`upsert`).
    pub async fn replace_one_with(&self, filter: Document, replacement: impl Borrow<T>, options: impl Into<Option<ReplaceOptions>>) -> Result<UpdateResult, Error>
    where
        T: Serialize,
    {
        let mut session = self.open(doc! { "update": self.name() }, "update").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.replace_one(filter, replacement).with_options(options).session(session).await,
            None => self.inner.replace_one(filter, replacement).with_options(options).await,
        }
    }

    /// Deletes the first document matching `filter`.
    pub async fn delete_one(&self, filter: Document) -> Result<DeleteResult, Error> {
        let mut session = self.open(doc! { "delete": self.name() }, "delete").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.delete_one(filter).session(session).await,
            None => self.inner.delete_one(filter).await,
        }
    }

    /// Deletes every document matching `filter`.
    pub async fn delete_many(&self, filter: Document) -> Result<DeleteResult, Error> {
        let mut session = self.open(doc! { "delete": self.name() }, "delete").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.delete_many(filter).session(session).await,
            None => self.inner.delete_many(filter).await,
        }
    }

    /// Finds, updates and returns one document (`findAndModify`, always a write).
    pub async fn find_one_and_update(&self, filter: Document, update: impl Into<UpdateModifications>) -> Result<Option<T>, Error>
    where
        T: DeserializeOwned,
    {
        self.find_one_and_update_with(filter, update, None).await
    }

    /// [`find_one_and_update`](Self::find_one_and_update) with options (`upsert`, `return_document`).
    pub async fn find_one_and_update_with(&self, filter: Document, update: impl Into<UpdateModifications>, options: impl Into<Option<FindOneAndUpdateOptions>>) -> Result<Option<T>, Error>
    where
        T: DeserializeOwned,
    {
        let mut session = self.open(doc! { "findAndModify": self.name() }, "findAndModify").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.find_one_and_update(filter, update).with_options(options).session(session).await,
            None => self.inner.find_one_and_update(filter, update).with_options(options).await,
        }
    }

    /// Finds, replaces and returns one document (`findAndModify`).
    pub async fn find_one_and_replace(&self, filter: Document, replacement: impl Borrow<T>) -> Result<Option<T>, Error>
    where
        T: Serialize + DeserializeOwned,
    {
        self.find_one_and_replace_with(filter, replacement, None).await
    }

    /// [`find_one_and_replace`](Self::find_one_and_replace) with options.
    pub async fn find_one_and_replace_with(&self, filter: Document, replacement: impl Borrow<T>, options: impl Into<Option<FindOneAndReplaceOptions>>) -> Result<Option<T>, Error>
    where
        T: Serialize + DeserializeOwned,
    {
        let mut session = self.open(doc! { "findAndModify": self.name() }, "findAndModify").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.find_one_and_replace(filter, replacement).with_options(options).session(session).await,
            None => self.inner.find_one_and_replace(filter, replacement).with_options(options).await,
        }
    }

    /// Finds, deletes and returns one document (`findAndModify`).
    pub async fn find_one_and_delete(&self, filter: Document) -> Result<Option<T>, Error>
    where
        T: DeserializeOwned,
    {
        let mut session = self.open(doc! { "findAndModify": self.name() }, "findAndModify").await?;
        match session.as_deref_mut() {
            Some(session) => self.inner.find_one_and_delete(filter).session(session).await,
            None => self.inner.find_one_and_delete(filter).await,
        }
    }

    /// Creates an index. A collection command: blocked in every Preview (MongoDB refuses it inside a
    /// transaction on an existing collection, and it can't be undone in `guard` mode).
    pub async fn create_index(&self, index: IndexModel) -> Result<CreateIndexResult, Error> {
        self.open(doc! { "createIndexes": self.name() }, "createIndexes").await?;
        if self.access.scope.in_preview() {
            // `createIndexes` is refused inside a transaction only on an existing collection, and this
            // call doesn't carry the session: never send it during a Preview.
            self.access.scope.guard(crate::SYSTEM, "createIndexes", CommandKind::Write, Some(&refused_reason("createIndexes"))).map_err(Error::custom)?;
        }
        self.inner.create_index(index).await
    }

    /// Drops the collection. Blocked in every Preview.
    pub async fn drop(&self) -> Result<(), Error> {
        self.open(doc! { "drop": self.name() }, "drop").await?;
        self.inner.drop().await
    }
}
