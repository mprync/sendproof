//! Cookie sessions, the password sign-in and the development personas.

use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Serialize;
use testbench_core::{Headers, Identity};

/// The name of the session cookie.
pub const COOKIE: &str = "bench_session";

/// A fixture account.
#[derive(Clone, Serialize)]
pub struct Persona {
    pub email: &'static str,
    pub name: &'static str,
    pub role: &'static str,
}

pub const ADMIN: Persona = Persona {
    email: "admin@example.test",
    name: "Fixture Admin",
    role: "admin",
};
pub const VIEWER: Persona = Persona {
    email: "viewer@example.test",
    name: "Fixture Viewer",
    role: "viewer",
};
pub const PERSONAS: [Persona; 2] = [ADMIN, VIEWER];

/// Whether the credentials sign in the admin.
pub fn credentials_ok(email: &str, password: &str) -> bool {
    email == ADMIN.email && password == "bench-fixture"
}

/// An unguessable 128-bit session token. Hosts copy fixtures, so even a loopback session must not be
/// predictable from a counter or the process id. The standard library's SipHash keys are seeded from the
/// operating system, which keeps the fixture free of a random-number dependency on every platform.
fn session_token(sequence: u64) -> String {
    use std::hash::{BuildHasher, Hasher, RandomState};
    let [high, low]: [u64; 2] = std::array::from_fn(|lane| {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(sequence);
        hasher.write_usize(lane);
        hasher.finish()
    });
    format!("{high:016x}{low:016x}")
}

/// Server-side sessions for a loopback fixture.
#[derive(Default)]
pub struct Sessions {
    next: AtomicU64,
    by_token: Mutex<HashMap<String, Persona>>,
}

impl Sessions {
    /// Starts a session and returns the `Set-Cookie` value for it.
    pub fn start(&self, persona: Persona) -> String {
        let token = session_token(self.next.fetch_add(1, Ordering::SeqCst));
        self.by_token.lock().unwrap().insert(token.clone(), persona);
        format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax")
    }

    /// The signed-in persona of a request.
    pub fn lookup(&self, headers: &Headers) -> Option<Persona> {
        self.by_token
            .lock()
            .unwrap()
            .get(headers.cookie(COOKIE)?)
            .cloned()
    }

    /// The identity Test Bench shows and uses to own traces.
    pub fn identity(&self, headers: &Headers) -> Option<Identity> {
        self.lookup(headers).map(|persona| Identity {
            name: Some(persona.name.into()),
            role: Some(persona.role.into()),
            subject: Some(persona.email.into()),
            authentication_type: Some("cookie".into()),
        })
    }

    /// Anonymous callers get 401. A viewer may read; any other method needs the admin.
    pub fn authorize(&self, headers: &Headers, method: &str) -> Result<(), u16> {
        let persona = self.lookup(headers).ok_or(401u16)?;
        let reads = method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD");
        if !reads && persona.role != "admin" {
            Err(403)
        } else {
            Ok(())
        }
    }

    /// Lists the personas, for an admin only. `Err` is the status to answer with.
    pub fn list_personas(&self, headers: &Headers) -> Result<Vec<Persona>, u16> {
        self.require_admin(headers).map(|_| PERSONAS.to_vec())
    }

    /// Switches to the persona with `email`, for an admin only. `Ok` is the persona and its cookie.
    pub fn switch(&self, headers: &Headers, email: &str) -> Result<(Persona, String), u16> {
        self.require_admin(headers)?;
        let persona = PERSONAS
            .iter()
            .find(|p| p.email == email)
            .cloned()
            .ok_or(404u16)?;
        let cookie = self.start(persona.clone());
        Ok((persona, cookie))
    }

    fn require_admin(&self, headers: &Headers) -> Result<Persona, u16> {
        match self.lookup(headers) {
            None => Err(401),
            Some(persona) if persona.role != "admin" => Err(403),
            Some(persona) => Ok(persona),
        }
    }
}
