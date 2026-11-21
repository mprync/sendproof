"""URLconf of the Django data-store tests: views that write to Redis and MongoDB, hooked by the tests."""

import json

from asgiref.sync import sync_to_async
from django.db import connection
from django.http import JsonResponse
from django.urls import path

from sendproof_core.stores import PreviewWriteBlocked
from sendproof_django import preview
from urls_under_test import Item

#: The hooked clients and key prefix the tests install before sending requests.
HOLD: dict = {}


def key() -> str:
    return HOLD["prefix"] + "counter"


@preview(methods=["GET"])
def read(request):
    return JsonResponse({"value": int(HOLD["redis"].get(key()) or 0)})


@preview(methods=["POST"])
def bump(request):
    return JsonResponse({"value": HOLD["redis"].execute_command("INCR", key())})


@preview(methods=["POST"])
def swallow(request):
    try:
        HOLD["redis"].execute_command("INCR", key())
    except PreviewWriteBlocked:
        pass  # the handler hides the refusal
    return JsonResponse({"ok": True})


@preview(False, methods=["DELETE"], stores=["redis"])
def clear(request):
    HOLD["redis"].delete(key())
    return JsonResponse({}, status=200)


@preview(methods=["POST"])
def mixed(request):
    Item.objects.create(id="mixed", name="x")
    HOLD["redis"].execute_command("INCR", key())
    return JsonResponse({"ok": True}, status=201)


@preview(methods=["POST"])
def commit(request):
    Item.objects.create(id="commit", name="x")
    with connection.cursor() as cursor:
        cursor.execute("COMMIT")
    return JsonResponse({"ok": True}, status=201)


@preview(methods=["POST"])
async def async_bump(request):
    """An async view: the store call hops to a thread with ``sync_to_async``, which must carry the Preview's context."""
    value = await sync_to_async(HOLD["redis"].execute_command)("INCR", key())
    return JsonResponse({"value": value})


@preview(methods=["POST"])
def document(request):
    data = json.loads(request.body)
    HOLD["documents"].insert_one({"_id": data["id"], "profile": {"city": data["city"]}, "password_hash": "hashed:pw"})
    return JsonResponse({"id": data["id"]}, status=201)


urlpatterns = [
    path("counters", read),
    path("counters/bump", bump),
    path("counters/swallow", swallow),
    path("counters/clear", clear),
    path("counters/mixed", mixed),
    path("counters/commit", commit),
    path("counters/async", async_bump),
    path("documents", document),
]
