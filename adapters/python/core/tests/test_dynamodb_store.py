"""The DynamoDB write guard against DynamoDB Local (``docker compose -f tests/conformance/compose.yml up -d dynamodb``).

Covers boto3 clients, sessions and resources, botocore sessions, and aioboto3. An independent,
unhooked client reads the table back, so a passing check proves the refused operation never
reached DynamoDB.
"""

from __future__ import annotations

import os

import boto3
import botocore.exceptions
import botocore.session
import pytest

from sendproof_core.stores import PreviewWriteBlocked, dynamodb_store
from store_support import DYNAMODB_URL, REGION, active, db_entries, dynamo_client, dynamo_table, needs, observed_scope, preview_scope

pytestmark = needs("dynamodb")


@pytest.fixture
def table():
    with dynamo_table() as name:
        dynamo_client().put_item(TableName=name, Item={"id": {"S": "seeded"}, "status": {"S": "open"}, "hits": {"N": "3"}})
        yield name


def item_of(table: str, identifier: str):
    return dynamo_client().get_item(TableName=table, Key={"id": {"S": identifier}}, ConsistentRead=True).get("Item")


def touch(table: str, identifier: str) -> dict:
    return dict(
        TableName=table, Key={"id": {"S": identifier}}, UpdateExpression="ADD hits :one SET #s = if_not_exists(#s, :new)",
        ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={":one": {"N": "1"}, ":new": {"S": "new"}},
        ReturnValues="ALL_NEW",
    )


def hooked_client(**options):
    session = boto3.Session(region_name=REGION)
    store = dynamodb_store(session, **options)
    return session.client("dynamodb", endpoint_url=DYNAMODB_URL), store


def test_reads_run_and_writes_are_refused_before_any_request_is_built(table):
    client, store = hooked_client(name="orders")
    with active(preview_scope()) as scope:
        assert client.get_item(TableName=table, Key={"id": {"S": "seeded"}})["Item"]["status"] == {"S": "open"}
        assert client.query(TableName=table, KeyConditionExpression="id = :i", ExpressionAttributeValues={":i": {"S": "seeded"}})["Count"] == 1
        with pytest.raises(PreviewWriteBlocked) as blocked:
            client.update_item(**touch(table, "blocked"))
        assert (blocked.value.store, blocked.value.operation) == ("dynamodb", "UpdateItem")
        for refuse in (
            lambda: client.put_item(TableName=table, Item={"id": {"S": "p"}}),
            lambda: client.delete_item(TableName=table, Key={"id": {"S": "seeded"}}),
            lambda: client.batch_write_item(RequestItems={table: [{"PutRequest": {"Item": {"id": {"S": "b"}}}}]}),
            lambda: client.transact_write_items(TransactItems=[{"ConditionCheck": {
                "TableName": table, "Key": {"id": {"S": "seeded"}}, "ConditionExpression": "attribute_exists(id)"}}]),
        ):
            with pytest.raises(PreviewWriteBlocked):
                refuse()
        assert scope.capture.blocked["operation"] == "UpdateItem"  # the first block wins
    assert item_of(table, "blocked") is None and item_of(table, "p") is None and item_of(table, "b") is None
    assert item_of(table, "seeded")["status"] == {"S": "open"}
    assert store.describe() == {"system": "dynamodb", "name": "orders", "mode": "guard"}


def test_partiql_select_runs_but_update_insert_and_unparseable_text_are_writes(table):
    client, _ = hooked_client()
    with active(preview_scope()):
        found = client.execute_statement(Statement=f'  -- read\n SELECT * FROM "{table}" WHERE id = ?', Parameters=[{"S": "seeded"}])
        assert found["Items"][0]["status"] == {"S": "open"}
        for statement in (f"UPDATE \"{table}\" SET status = 'cancelled' WHERE id = 'seeded'", f"INSERT INTO \"{table}\" VALUE {{'id': 'x'}}", "/* never closed SELECT"):
            with pytest.raises(PreviewWriteBlocked) as blocked:
                client.execute_statement(Statement=statement)
            assert blocked.value.operation == "ExecuteStatement"
        with pytest.raises(PreviewWriteBlocked):
            client.batch_execute_statement(Statements=[{"Statement": f'SELECT * FROM "{table}"'}, {"Statement": f"DELETE FROM \"{table}\" WHERE id = ?"}])
    assert item_of(table, "seeded")["status"] == {"S": "open"}


def test_outside_a_preview_and_in_observed_send_writes_commit_and_are_logged(table):
    client, _ = hooked_client()
    assert client.update_item(**touch(table, "plain"))["Attributes"]["hits"] == {"N": "1"}  # no scope at all
    with active(observed_scope()) as scope:
        client.update_item(**touch(table, "plain"))
        found = client.get_item(TableName=table, Key={"id": {"S": "plain"}})
        entries = db_entries(scope, "dynamodb")
    assert [e["db"]["operation"] for e in entries] == ["UpdateItem", "GetItem"]
    assert entries[0]["db"]["target"] == table and entries[1]["db"]["rowsAffected"] == 1
    assert found["Item"]["hits"] == {"N": "2"} and item_of(table, "plain")["hits"] == {"N": "2"}


def test_inline_partiql_literals_are_replaced_in_db_statements_and_secrets_never_logged(table):
    client, _ = hooked_client()
    with active(observed_scope()) as scope:
        client.execute_statement(Statement=f"UPDATE \"{table}\" SET status = 'it''s a secret', hits = 42 WHERE id = 'seeded'")
        client.execute_statement(Statement=f'SELECT * FROM "{table}" WHERE id = ?', Parameters=[{"S": "seeded"}])
        entries = db_entries(scope, "dynamodb")
    assert entries[0]["db"]["statement"] == f'UPDATE "{table}" SET status = ?, hits = ? WHERE id = ?'
    assert entries[0]["db"]["target"] == table
    assert entries[1]["db"]["statement"] == f'SELECT * FROM "{table}" WHERE id = ?'
    text = repr(entries)
    for secret in ("a secret", os.environ["AWS_SECRET_ACCESS_KEY"], "AWS4-HMAC-SHA256", os.environ["AWS_ACCESS_KEY_ID"]):
        assert secret not in text


def test_a_failed_operation_logs_its_error_code():
    client, _ = hooked_client()
    with active(observed_scope()) as scope:
        with pytest.raises(client.exceptions.ResourceNotFoundException):
            client.get_item(TableName="no_such_table_" + os.urandom(3).hex(), Key={"id": {"S": "x"}})
        (entry,) = db_entries(scope, "dynamodb", "GetItem")
    assert entry["db"]["error"] == "ResourceNotFoundException"


def test_resources_and_tables_pass_through_the_hook(table):
    session = boto3.Session(region_name=REGION)
    dynamodb_store(session)
    resource = session.resource("dynamodb", endpoint_url=DYNAMODB_URL)
    orders = resource.Table(table)
    with active(preview_scope()):
        assert orders.get_item(Key={"id": "seeded"})["Item"]["status"] == "open"
        with pytest.raises(PreviewWriteBlocked):
            orders.put_item(Item={"id": "viaresource", "status": "x"})
        with pytest.raises(PreviewWriteBlocked):
            orders.update_item(Key={"id": "seeded"}, UpdateExpression="SET #s = :s", ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={":s": "closed"})
    assert item_of(table, "viaresource") is None and item_of(table, "seeded")["status"] == {"S": "open"}


def test_a_session_covers_clients_made_from_it_afterwards_and_a_client_hooks_only_itself(table):
    early = boto3.Session(region_name=REGION)
    before = early.client("dynamodb", endpoint_url=DYNAMODB_URL)  # made before the hook: not covered
    dynamodb_store(early)
    after = early.client("dynamodb", endpoint_url=DYNAMODB_URL)
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            after.put_item(TableName=table, Item={"id": {"S": "after"}})
        before.put_item(TableName=table, Item={"id": {"S": "before"}})  # documented limit: an unhooked client is not covered
    assert item_of(table, "after") is None and item_of(table, "before") is not None

    lone = boto3.Session(region_name=REGION).client("dynamodb", endpoint_url=DYNAMODB_URL)
    dynamodb_store(lone)
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            lone.put_item(TableName=table, Item={"id": {"S": "lone"}})


def test_a_botocore_session_is_hooked_too(table):
    session = botocore.session.get_session()
    dynamodb_store(session)
    client = session.create_client("dynamodb", region_name=REGION, endpoint_url=DYNAMODB_URL)
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            client.put_item(TableName=table, Item={"id": {"S": "bc"}})
    assert item_of(table, "bc") is None


def test_host_declared_reads_and_double_hooking_and_labels():
    session = boto3.Session(region_name=REGION)
    dynamodb_store(session, treat_as_read=["CreateBackup"])
    client = session.client("dynamodb", endpoint_url=DYNAMODB_URL)
    with active(preview_scope()):
        # A listed action passes the guard (the service then refuses it); an unlisted write does not.
        with pytest.raises(botocore.exceptions.ClientError):
            client.create_backup(TableName="no_such_table", BackupName="backup")
        with pytest.raises(PreviewWriteBlocked):
            client.delete_backup(BackupArn="arn:aws:dynamodb:us-east-1:000000000000:table/t/backup/1")
    with pytest.raises(TypeError):
        dynamodb_store(client)  # the session's handlers were copied into it: already hooked
    with pytest.raises(ValueError):
        dynamodb_store(boto3.Session(), name="http://localhost:8000")
    with pytest.raises(TypeError):
        dynamodb_store(object())


def test_the_checks_fail_without_the_hook(table):
    """The negative test: an unhooked client sends the write, so the guard checks above would fail."""
    client = dynamo_client()
    with active(preview_scope()) as scope:
        client.put_item(TableName=table, Item={"id": {"S": "unhooked"}})
        assert scope.capture.blocked is None
    assert item_of(table, "unhooked") is not None  # the write reached DynamoDB


async def test_aioboto3_clients_are_guarded(table):
    aioboto3 = pytest.importorskip("aioboto3")
    session = aioboto3.Session(region_name=REGION)
    dynamodb_store(session)
    async with session.client("dynamodb", endpoint_url=DYNAMODB_URL) as client:
        with active(preview_scope()) as scope:
            assert (await client.get_item(TableName=table, Key={"id": {"S": "seeded"}}))["Item"]["hits"] == {"N": "3"}
            with pytest.raises(PreviewWriteBlocked):
                await client.update_item(**touch(table, "aio"))
            with pytest.raises(PreviewWriteBlocked):
                await client.execute_statement(Statement=f"UPDATE \"{table}\" SET status = 'x' WHERE id = 'seeded'")
            assert scope.capture.blocked["operation"] == "UpdateItem"
        with active(observed_scope()) as scope:
            await client.update_item(**touch(table, "aio"))
            assert [e["db"]["operation"] for e in db_entries(scope, "dynamodb")] == ["UpdateItem"]
    assert item_of(table, "aio")["hits"] == {"N": "1"}  # only the observed write committed
    assert item_of(table, "seeded")["status"] == {"S": "open"}
