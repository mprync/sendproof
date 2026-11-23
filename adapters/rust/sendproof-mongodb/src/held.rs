//! One MongoDB transaction retained across Preview requests. MongoDB has no savepoints, so every
//! successful step keeps raw BSON before images and rewind restores them inside that transaction.

use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, atomic::Ordering},
    time::Instant,
};

use mongodb::{
    bson::{Bson, Document, doc},
    error::Error,
    options::ReplaceOptions,
};
use sendproof_core::{
    BoxError, BoxFuture, Changes, HeldPreview, HeldStepError, OpenSessionError, capture::Recorder, model::Change, stores::CaptureScope,
};

use crate::{
    SYSTEM, States,
    engine::{CANDIDATE_LIMIT, Engine, NO_SUCH_TRANSACTION, code_of},
    monitor::INTERNAL,
    plain,
    preview::{Candidate, Mode, PreviewState, UNMONITORED_REASON, UNREACHABLE_REASON, candidate_key},
};

/// Bound raw BSON history across *all* retained steps, not merely one step's 1,000 candidates.
/// Documents may each approach MongoDB's 16 MiB limit, so a document-count cap alone does not
/// protect a long-lived session. The accounting includes `_id`, names and retained document BSON;
/// a step crossing the cap fails closed and the core ends its transaction.
const MAX_HELD_IMAGE_BYTES: usize = 32 * 1024 * 1024;

fn image_budget_error() -> Error {
    Error::custom(sendproof_core::ConfigError(
        "MongoDB Preview session exceeded its 32 MiB before-image budget; it cannot be rewound.".into(),
    ))
}

#[derive(Clone)]
struct Image {
    candidate: Candidate,
    document: Option<Document>,
    bytes: usize,
}

impl Image {
    fn new(candidate: Candidate, document: Option<Document>) -> Result<Self, Error> {
        let id_bytes = mongodb::bson::to_vec(&doc! { "_id": candidate.id.clone() }).map_err(Error::custom)?.len();
        let document_bytes =
            document.as_ref().map(mongodb::bson::to_vec).transpose().map_err(Error::custom)?.map_or(0, |value| value.len());
        // Charge a fixed allocation allowance for the map entry and BSON's in-memory tree.
        let bytes = id_bytes + document_bytes + candidate.namespace.len() + candidate.collection.len() + 128;
        Ok(Self { candidate, document, bytes })
    }
}

/// A held store fixes its mode on open. Even a guard-only MongoDB store registers each step, so a
/// standalone server cannot silently upgrade to a transaction when topology detection later changes.
pub(crate) struct MongoHeld {
    engine: Arc<Engine>,
    anchor: Arc<PreviewState>,
    current: Option<Arc<PreviewState>>,
    known: HashMap<String, Image>,
    steps: BTreeMap<u32, HashMap<String, Image>>,
    history_bytes: usize,
    step: u32,
    ended: bool,
}

impl MongoHeld {
    pub async fn open(engine: Arc<Engine>) -> Result<Self, OpenSessionError> {
        // Session open must not inherit the driver's potentially long server-selection timeout.
        let detected = tokio::time::timeout(std::time::Duration::from_secs(4), engine.detect())
            .await
            .map_err(|_| OpenSessionError::Failed("MongoDB could not be reached while opening the session.".into()))?;
        if detected.reason == Some(UNREACHABLE_REASON) {
            return Err(OpenSessionError::Failed("MongoDB could not be reached while opening the session.".into()));
        }
        if !detected.monitored {
            return Err(OpenSessionError::Failed(UNMONITORED_REASON.into()));
        }
        let recorder = Recorder::new_preview(Instant::now(), false);
        let anchor = match detected.mode {
            Mode::Preview => {
                let mut session = tokio::time::timeout(std::time::Duration::from_secs(4), engine.client.start_session())
                    .await
                    .map_err(|_| OpenSessionError::Failed("MongoDB could not start a session in time.".into()))?
                    .map_err(|error| OpenSessionError::Failed(error.into()))?;
                session
                    .start_transaction()
                    .read_concern(mongodb::options::ReadConcern::snapshot())
                    .write_concern(mongodb::options::WriteConcern::majority())
                    .await
                    .map_err(|error| OpenSessionError::Failed(error.into()))?;
                PreviewState::new(session, recorder)
            }
            Mode::Guard => PreviewState::guard(recorder),
        };
        Ok(Self { engine, anchor, current: None, known: HashMap::new(), steps: BTreeMap::new(), history_bytes: 0, step: 0, ended: false })
    }

    fn finish_step(&mut self) {
        if let Some(state) = self.current.take() {
            let data = state.data();
            let mut anchor = self.anchor.data();
            anchor.opened |= data.opened;
            if anchor.start_time.is_none() {
                anchor.start_time = data.start_time;
            }
            drop(anchor);
            drop(data);
            state.active.store(false, Ordering::SeqCst);
            self.engine.shared.forget(&state);
        }
    }

    /// Read every earlier touched document as well as this step's candidates. A document first
    /// touched here uses the transaction's original snapshot; a previously touched one uses the
    /// image left by the preceding step. The latter is essential for insert, read, update journeys.
    async fn capture_step(&mut self) -> Result<Changes, Error> {
        let Some(state) = self.current.as_ref() else { return Ok(Changes::default()) };
        if state.mode == Mode::Guard {
            return Ok(Changes::default());
        }
        let session = state.session.as_ref().expect("preview mode has a session");
        let mut session = session.lock().await;
        if self.anchor.data().opened || state.data().opened {
            // A read-only step can catch and swallow NoSuchTransaction. Probe before declaring it
            // successful, including when this step issued no commands after an earlier write.
            INTERNAL
                .scope((), async {
                    self.engine
                        .client
                        .database(&self.engine.database)
                        .collection::<Document>("__sendproof_session_probe")
                        .find_one(doc! {})
                        .session(&mut *session)
                        .await
                })
                .await?;
        }
        if !state.data().used {
            return Ok(Changes::default());
        }
        for image in self.known.values() {
            state.candidate(image.candidate.clone());
        }
        let filters = state.data().filters.clone();
        for filter in filters {
            let target = self.engine.client.database(&filter.namespace).collection::<Document>(&filter.collection);
            let projection = doc! { "_id": 1 };
            let mut cursor = INTERNAL
                .scope((), async {
                    target
                        .find(filter.filter.clone())
                        .projection(projection.clone())
                        .limit((CANDIDATE_LIMIT + 1) as i64)
                        .session(&mut *session)
                        .await
                })
                .await?;
            let mut inside = Vec::new();
            let mut inside_bytes = 0usize;
            while let Some(document) = INTERNAL.scope((), cursor.next(&mut *session)).await {
                let document = document?;
                inside_bytes += mongodb::bson::to_vec(&document).map_err(Error::custom)?.len();
                if inside_bytes > MAX_HELD_IMAGE_BYTES {
                    return Err(Error::custom(sendproof_core::ConfigError(
                        "MongoDB step matched more BSON than the session's 32 MiB image budget.".into(),
                    )));
                }
                inside.push(document);
                if inside.len() > CANDIDATE_LIMIT {
                    break;
                }
            }
            let (before, more) = INTERNAL
                .scope((), self.engine.at_start_batch(&state, &filter.namespace, &filter.collection, &filter.filter, Some(&projection)))
                .await?;
            if inside.len() > CANDIDATE_LIMIT || before.len() > CANDIDATE_LIMIT || more {
                return Err(Error::custom(sendproof_core::ConfigError(
                    "MongoDB step matched more documents than the capture limit; it cannot be rewound.".into(),
                )));
            }
            for document in inside.into_iter().chain(before) {
                state.candidate(Candidate {
                    namespace: filter.namespace.clone(),
                    collection: filter.collection.clone(),
                    id: document.get("_id").cloned().unwrap_or(Bson::Null),
                    via: filter.via,
                });
                if state.data().candidates.len() > CANDIDATE_LIMIT {
                    break;
                }
            }
        }
        let candidates = state.data().candidates.clone();
        // An incomplete undo log cannot be offered as a rewind checkpoint.
        if candidates.len() > CANDIDATE_LIMIT {
            return Err(Error::custom(sendproof_core::ConfigError(
                "MongoDB step changed more documents than the capture limit; it cannot be rewound.".into(),
            )));
        }
        let mut changes = Changes::default();
        let mut undo = HashMap::new();
        let mut updates = HashMap::new();
        let replaced_step: usize = self.steps.get(&self.step).into_iter().flat_map(HashMap::values).map(|image| image.bytes).sum();
        let mut projected_bytes = self.history_bytes - replaced_step;
        for candidate in candidates {
            let key = candidate_key(&candidate);
            let target = self.engine.client.database(&candidate.namespace).collection::<Document>(&candidate.collection);
            let before = match self.known.get(&key) {
                Some(image) => image.document.clone(),
                None => INTERNAL
                    .scope(
                        (),
                        self.engine.at_start(
                            &state,
                            &candidate.namespace,
                            &candidate.collection,
                            &doc! { "_id": candidate.id.clone() },
                            None,
                        ),
                    )
                    .await?
                    .into_iter()
                    .next(),
            };
            let after =
                INTERNAL.scope((), async { target.find_one(doc! { "_id": candidate.id.clone() }).session(&mut *session).await }).await?;
            let mut stable = candidate.clone();
            stable.via = None;
            let next = Image::new(stable.clone(), after.clone())?;
            projected_bytes = projected_bytes - self.known.get(&key).map_or(0, |image| image.bytes) + next.bytes;
            updates.insert(key.clone(), next);
            if before == after {
                if projected_bytes > MAX_HELD_IMAGE_BYTES {
                    return Err(image_budget_error());
                }
                continue;
            }
            let before_image = Image::new(stable, before.clone())?;
            projected_bytes += before_image.bytes;
            if projected_bytes > MAX_HELD_IMAGE_BYTES {
                return Err(image_budget_error());
            }
            undo.insert(key, before_image);
            let (was, now) = (before.map(|value| plain(&Bson::Document(value))), after.map(|value| plain(&Bson::Document(value))));
            let operation = if was.is_none() {
                "insert"
            } else if now.is_none() {
                "delete"
            } else {
                "update"
            };
            changes.changes.push(Change {
                operation: operation.into(),
                table: candidate.collection.clone(),
                key: Some(serde_json::json!({ "_id": plain(&candidate.id) })),
                before: was,
                after: now,
                store: Some(SYSTEM.into()),
                namespace: Some(candidate.namespace),
                via: candidate.via.filter(|_| operation != "delete").map(str::to_owned),
            });
        }
        self.history_bytes = projected_bytes;
        self.known.extend(updates);
        if !undo.is_empty() {
            self.steps.insert(self.step, undo);
        }
        Ok(changes)
    }

    async fn rewind_to(&mut self, step: u32) -> Result<(), BoxError> {
        if self.current.is_some() {
            self.capture_step().await.map_err(|error| {
                if code_of(&error) == NO_SUCH_TRANSACTION {
                    self.ended = true;
                }
                Box::new(error) as BoxError
            })?;
            self.finish_step();
        }
        if self.anchor.mode == Mode::Guard {
            return Ok(());
        }
        let session = self.anchor.session.as_ref().expect("preview mode has a session").clone();
        let mut session = session.lock().await;
        if self.anchor.data().opened {
            let probe = INTERNAL
                .scope((), async {
                    self.engine
                        .client
                        .database(&self.engine.database)
                        .collection::<Document>("__sendproof_session_probe")
                        .find_one(doc! {})
                        .session(&mut *session)
                        .await
                })
                .await;
            if let Err(error) = probe {
                if code_of(&error) == NO_SUCH_TRANSACTION {
                    self.ended = true;
                }
                return Err(error.into());
            }
        }
        for (_, images) in self.steps.range(step..).rev() {
            for (key, image) in images {
                let collection =
                    self.engine.client.database(&image.candidate.namespace).collection::<Document>(&image.candidate.collection);
                let filter = doc! { "_id": image.candidate.id.clone() };
                let result = match &image.document {
                    Some(document) => INTERNAL
                        .scope((), async {
                            collection
                                .replace_one(filter, document.clone())
                                .with_options(ReplaceOptions::builder().upsert(true).build())
                                .session(&mut *session)
                                .await
                        })
                        .await
                        .map(|_| ()),
                    None => INTERNAL.scope((), async { collection.delete_one(filter).session(&mut *session).await }).await.map(|_| ()),
                };
                if let Err(error) = result {
                    if code_of(&error) == NO_SUCH_TRANSACTION {
                        self.ended = true;
                    }
                    return Err(error.into());
                }
                self.known.insert(key.clone(), image.clone());
            }
        }
        self.steps.retain(|number, _| *number < step);
        self.history_bytes = self.known.values().map(|image| image.bytes).sum::<usize>()
            + self.steps.values().flat_map(HashMap::values).map(|image| image.bytes).sum::<usize>();
        Ok(())
    }
}

impl HeldPreview for MongoHeld {
    fn begin_step<'a>(&'a mut self, step: u32, extensions: &'a mut http::Extensions) -> BoxFuture<'a, Result<(), BoxError>> {
        Box::pin(async move {
            if self.ended || self.anchor.lifetime_ended.load(Ordering::SeqCst) {
                return Err("The MongoDB session's transaction has ended.".into());
            }
            if self.current.is_some() {
                return Err("The previous MongoDB step is still open.".into());
            }
            let recorder = extensions.get::<CaptureScope>().map(|scope| scope.0.clone()).ok_or("the Preview has no capture scope")?;
            let state = PreviewState::step(&self.anchor, recorder);
            self.engine.shared.register(state.clone());
            let id = Arc::as_ptr(&self.engine) as usize;
            match extensions.get_mut::<States>() {
                Some(states) => states.0.push((id, state.clone())),
                None => {
                    extensions.insert(States(vec![(id, state.clone())]));
                }
            }
            self.step = step;
            self.current = Some(state);
            Ok(())
        })
    }

    fn keep_step(&mut self) -> BoxFuture<'_, Result<Changes, HeldStepError>> {
        Box::pin(async move {
            let result = self.capture_step().await;
            match result {
                Ok(changes) => {
                    self.finish_step();
                    Ok(changes)
                }
                Err(error) if code_of(&error) == NO_SUCH_TRANSACTION => {
                    self.ended = true;
                    Err(HeldStepError::Ended(error.into()))
                }
                Err(error) => Err(HeldStepError::Broken(error.into())),
            }
        })
    }

    fn rewind(&mut self, step: u32) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async move { self.rewind_to(step).await })
    }

    fn end(mut self: Box<Self>) -> BoxFuture<'static, Result<(), BoxError>> {
        self.ended = true;
        self.finish_step();
        Box::pin(async move {
            let result = self.engine.end(&self.anchor, false).await;
            if result { Ok(()) } else { Err("MongoDB did not acknowledge the held transaction's abort.".into()) }
        })
    }

    fn ended(&self, error: &BoxError) -> bool {
        self.ended
            || self.anchor.lifetime_ended.load(Ordering::SeqCst)
            || error.downcast_ref::<Error>().is_some_and(|error| code_of(error) == NO_SUCH_TRANSACTION)
    }
}

impl Drop for MongoHeld {
    fn drop(&mut self) {
        self.finish_step();
        if self.anchor.mode == Mode::Preview
            && !self.anchor.lifetime_ended.load(Ordering::SeqCst)
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let (engine, anchor) = (self.engine.clone(), self.anchor.clone());
            runtime.spawn(async move {
                engine.end(&anchor, false).await;
            });
        }
    }
}
