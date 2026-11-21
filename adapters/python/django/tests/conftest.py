import tempfile
from pathlib import Path

import django
from django.conf import settings

_directory = Path(tempfile.mkdtemp(prefix="sendproof-django-tests-"))


def pytest_configure():
    from sendproof_django import DjangoOrmPreview

    settings.configure(
        DEBUG=False,
        SECRET_KEY="tests",
        ALLOWED_HOSTS=["*"],
        ROOT_URLCONF="urls_under_test",
        INSTALLED_APPS=["django.contrib.contenttypes", "django.contrib.sessions"],
        MIDDLEWARE=["sendproof_django.middleware.SendproofMiddleware"],
        DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": str(_directory / "tests.db")}},
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
