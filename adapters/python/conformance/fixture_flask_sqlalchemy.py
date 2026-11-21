"""Conformance fixture: the Flask fixture backed by the Flask-SQLAlchemy extension.

Same app, routes and OpenAPI document as ``fixture_flask.py``; only the persistence layer differs
(``db.session`` instead of a hand-managed ``Session``). Accepts the same environment variables.
"""

import os
import runpy
from pathlib import Path

os.environ["BENCH_FLASK_ORM"] = "flask-sqlalchemy"
runpy.run_path(str(Path(__file__).with_name("fixture_flask.py")), run_name="__main__")
