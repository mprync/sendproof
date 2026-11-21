from django.db import models, transaction
from django.http import JsonResponse
from django.urls import path
from rest_framework.response import Response
from rest_framework.views import APIView

from sendproof_core import Identity, record_email
from sendproof_django import preview

SENT: list[str] = []
COMMITTED: list[str] = []


class Item(models.Model):
    id = models.CharField(primary_key=True, max_length=50)
    name = models.CharField(max_length=50)

    class Meta:
        app_label = "tbtests"
        db_table = "items"


def identity(request):
    return Identity("Alex", "admin", "alex", "test") if request.COOKIES.get("user") == "alex" else None


@preview(methods=["POST"])
def create(request):
    import json

    data = json.loads(request.body)
    item = Item.objects.create(id=data["id"], name=data["name"])
    transaction.on_commit(lambda: COMMITTED.append(item.id))
    if not record_email("Created", "a@x", ["b@x"], [], "Hi", "Body"):
        SENT.append(item.id)
    return JsonResponse({"id": item.id, "name": item.name}, status=201)


@preview(methods=["PATCH"])
def rename(request, id):
    import json

    item = Item.objects.get(pk=id)
    item.name = json.loads(request.body)["name"]
    item.save()
    return JsonResponse({"id": item.id, "name": item.name})


def remove(request, id):  # not marked
    Item.objects.filter(pk=id).delete()
    return JsonResponse({}, status=204)


@preview(methods=["POST"])
def boom(request):
    Item.objects.create(id="boom", name="x")
    raise RuntimeError("unhandled")


@preview(methods=["POST"])
def denied(request):
    return JsonResponse({"detail": "no"}, status=403)


@preview(methods=["POST"])
def admin_create(request):
    Item.objects.create(id="admin", name="x")
    return JsonResponse({"ok": True}, status=201)


@preview(methods=["POST"])
def sign_in(request):
    request.session["user"] = "mallory"
    return JsonResponse({"ok": True})


@preview(methods=["POST"])
def escape(request):
    from django.db import connection

    Item.objects.create(id="escaped", name="x")
    with connection.cursor() as cursor:
        cursor.execute("COMMIT")
    return JsonResponse({"ok": True})


class AdminOnlyMiddleware:
    """A path-based policy of the kind many hosts write: /admin needs a header."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith("/admin") and request.headers.get("X-Admin") != "yes":
            return JsonResponse({"detail": "admins only"}, status=403)
        return self.get_response(request)


class Things(APIView):
    authentication_classes: list = []
    permission_classes: list = []

    def get(self, request):
        return Response({"ok": True})

    @preview
    def post(self, request):
        Item.objects.create(id=request.data["id"], name="drf")
        return Response({"id": request.data["id"]}, status=201)


urlpatterns = [
    path("items", create),
    path("items/<id>", rename),
    path("items/<id>/remove", remove),
    path("boom", boom),
    path("denied", denied),
    path("things", Things.as_view()),
    path("admin/items", admin_create),
    path("sign-in", sign_in),
    path("escape", escape),
]
