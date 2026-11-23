import json
from threading import Event

from sendproof_core import BenchOptions, Identity
from sendproof_core.sessions import PATH, Call, HeldPart, SessionRegistry, run
from sendproof_core.stores.base import StoresOnlyProvider


class Provider(StoresOnlyProvider):
    def __init__(self):
        self.closed = Event()

    def hold(self):
        closed = self.closed

        class Part(HeldPart):
            def close(self):
                closed.set()

        return Part()


def request(sessions, method, path=PATH, *, identity=Identity("Owner", subject="owner"), origin_ok=True):
    return run(sessions.route(path, method, identity, "/tenant", True, origin_ok, Call(list), Call(bytes)))


def test_session_limit_and_owner_admission():
    sessions = SessionRegistry(BenchOptions(environment="Development"), Provider(), ())
    try:
        assert request(sessions, "POST", identity=Identity("No subject")).status == 403
        opened = [request(sessions, "POST") for _ in range(4)]
        assert all(response.status == 201 for response in opened)
        assert request(sessions, "POST").status == 429
        path = PATH + "/" + json.loads(opened[0].body)["id"]
        assert request(sessions, "DELETE", path, identity=None).status == 404
        assert request(sessions, "DELETE", path, origin_ok=False).status == 404
        assert request(sessions, "DELETE", path).status == 204
        assert request(sessions, "POST").status == 201
    finally:
        sessions.close()


def test_idle_expiry_releases_the_store_and_hides_the_id():
    provider = Provider()
    sessions = SessionRegistry(BenchOptions(environment="Development", session_idle_timeout=1), provider, ())
    try:
        opened = request(sessions, "POST", identity=None)
        assert opened.status == 201
        assert provider.closed.wait(3)
        path = PATH + "/" + json.loads(opened.body)["id"]
        assert request(sessions, "DELETE", path, identity=None).status == 404
    finally:
        sessions.close()


def test_max_lifetime_releases_the_store_when_the_active_step_finishes():
    now = [0]
    provider = Provider()
    owner = Identity("Owner", subject="owner")
    sessions = SessionRegistry(BenchOptions(
        environment="Development", clock=lambda: now[0], session_max_lifetime=3,
    ), provider, ())
    try:
        opened = request(sessions, "POST", identity=owner)
        id = json.loads(opened.body)["id"]
        session = sessions.acquire(id, owner, "/tenant", True)
        now[0] = 4
        assert not provider.closed.is_set()
        assert run(sessions.release(session))
        assert provider.closed.is_set()
        assert request(sessions, "DELETE", PATH + "/" + id, identity=owner).status == 404
    finally:
        sessions.close()
