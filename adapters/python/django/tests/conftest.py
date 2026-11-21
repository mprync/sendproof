import os
import tempfile
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit

import django
from django.conf import settings

_directory = Path(tempfile.mkdtemp(prefix="sendproof-django-tests-"))

#: The server the MySQL tests use: the compose MySQL unless ``BENCH_MYSQL_URL`` names another.
MYSQL_URL = os.environ.get("BENCH_MYSQL_URL", "mysql://root:bench_local@127.0.0.1:53306/mysql")
#: The fresh database created for this run, or ``None`` when no MySQL server answered.
mysql_database: str | None = None


def _mysql_alias() -> dict:
    """A ``mysql`` database alias on a fresh database, through PyMySQL; empty when no server answers."""
    global mysql_database
    try:
        import pymysql

        url = urlsplit(MYSQL_URL)
        server = {"host": url.hostname, "port": url.port or 3306, "user": unquote(url.username or ""),
                  "password": unquote(url.password or "")}
        connection = pymysql.connect(**server, connect_timeout=2)
        name = "sp_django_" + uuid.uuid4().hex[:10]
        with connection.cursor() as cursor:
            cursor.execute(f"CREATE DATABASE {name}")
        connection.close()
    except Exception:  # noqa: BLE001 - no server: the MySQL tests skip
        return {}
    pymysql.install_as_MySQLdb()
    mysql_database = name
    return {"mysql": {"ENGINE": "django.db.backends.mysql", "NAME": name, "HOST": server["host"],
                      "PORT": server["port"], "USER": server["user"], "PASSWORD": server["password"]}}


def pytest_unconfigure():
    if mysql_database is not None:
        import pymysql

        url = urlsplit(MYSQL_URL)
        connection = pymysql.connect(host=url.hostname, port=url.port or 3306, user=unquote(url.username or ""),
                                     password=unquote(url.password or ""))
        with connection.cursor() as cursor:
            cursor.execute(f"DROP DATABASE IF EXISTS {mysql_database}")
        connection.close()


def pytest_configure():
    from sendproof_django import DjangoOrmPreview

    settings.configure(
        DEBUG=False,
        SECRET_KEY="tests",
        ALLOWED_HOSTS=["*"],
        ROOT_URLCONF="urls_under_test",
        INSTALLED_APPS=["django.contrib.contenttypes", "django.contrib.sessions"],
        MIDDLEWARE=["sendproof_django.middleware.SendproofMiddleware"],
        DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": str(_directory / "tests.db")},
                   **_mysql_alias()},
        DEFAULT_AUTO_FIELD="django.db.models.BigAutoField",
        LOGGING_CONFIG=None,
        REST_FRAMEWORK={"DEFAULT_AUTHENTICATION_CLASSES": [], "UNAUTHENTICATED_USER": None},
        SENDPROOF={
            "ENVIRONMENT": "Development",
            "PROVIDER": DjangoOrmPreview(database="tests"),
            "IDENTITY": "urls_under_test.identity",
            "TRACE_TTL": 5,
        },
    )
    django.setup()
    from django.contrib.sessions.models import Session
    from django.db import connection
    from urls_under_test import Item

    with connection.schema_editor() as editor:
        editor.create_model(Item)
        editor.create_model(Session)  # for the database session backend tests
