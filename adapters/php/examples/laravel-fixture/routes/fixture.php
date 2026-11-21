<?php

declare(strict_types=1);

use Aws\DynamoDb\DynamoDbClient;
use Aws\DynamoDb\Marshaler;
use Fixture\Models\Account;
use Fixture\Models\Item;
use Fixture\Support\Personas;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Facades\Route;
use Symfony\Component\HttpFoundation\Cookie;
use Sendproof\Laravel\Facades\Sendproof;

Route::get('/ready', fn () => response('ok'));

Route::get('/openapi/v1.json', function () {
    $item = ['$ref' => '#/components/schemas/Item'];
    $id = ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string']];
    $json = fn (array $schema) => ['content' => ['application/json' => ['schema' => $schema]]];
    $operation = fn (string $summary, array $extra = []) => ['summary' => $summary, 'responses' => ['200' => ['description' => 'OK']]] + $extra;
    $action = fn (string $name) => ['post' => $operation($name, ['parameters' => [$id]])];

    return response()->json([
        'openapi' => '3.1.0',
        'info' => ['title' => 'Sendproof Conformance', 'version' => '1.0.0'],
        'paths' => [
            '/items' => ['post' => $operation('Create item', ['requestBody' => ['required' => true] + $json($item), 'responses' => ['201' => ['description' => 'Created'] + $json($item)]])],
            '/items/{id}' => [
                'get' => $operation('Read item', ['parameters' => [$id], 'responses' => ['200' => ['description' => 'OK'] + $json($item), '404' => ['description' => 'Missing']]]),
                'patch' => $operation('Rename item', ['parameters' => [$id], 'requestBody' => ['required' => true] + $json(['type' => 'object', 'required' => ['name'], 'properties' => ['name' => ['type' => 'string']]])]),
                'delete' => $operation('Delete item', ['parameters' => [$id], 'responses' => ['204' => ['description' => 'Deleted']]]),
            ],
            '/items/{id}/fail' => $action('Fail after insert'),
            '/items/{id}/large' => $action('Oversized response'),
            '/items/{id}/redirect' => $action('Redirect with cookie'),
            '/items/{id}/capture' => $action('Exceed capture limits'),
            '/items/{id}/ordinary' => $action('Send only'),
            '/items/{id}/commit' => $action('Insert then COMMIT'),
            '/accounts' => ['post' => $operation('Create account')],
            '/accounts/{id}' => ['get' => $operation('Read account', ['parameters' => [$id]])],
            '/items/{id}/remember' => $action('Insert, then write a guarded store'),
            '/documents' => ['post' => $operation('Create document')],
            '/documents/archive' => ['post' => $operation('Archive documents')],
            '/documents/{id}' => [
                'get' => $operation('Read document', ['parameters' => [$id]]),
                'patch' => $operation('Update document', ['parameters' => [$id]]),
                'delete' => $operation('Delete document', ['parameters' => [$id]]),
            ],
            '/counters/{key}' => [
                'get' => $operation('Read counter', ['parameters' => [$id]]),
                'post' => $operation('Increment counter', ['parameters' => [$id]]),
                'delete' => $operation('Delete counter', ['parameters' => [$id]]),
            ],
            '/counters/{key}/take' => $action('Take counter'),
            '/orders/{id}' => [
                'get' => $operation('Read order', ['parameters' => [$id]]),
                'delete' => $operation('Delete order', ['parameters' => [$id]]),
            ],
            '/orders/{id}/touch' => $action('Touch order'),
            '/orders/{id}/cancel' => $action('Cancel order'),
        ],
        'components' => ['schemas' => ['Item' => [
            'type' => 'object', 'required' => ['id', 'name'],
            'properties' => ['id' => ['type' => 'string'], 'name' => ['type' => 'string']],
        ]]],
    ]);
});

// Authentication ---------------------------------------------------------------------------

Route::post('/auth/sign-in', function (Request $request) {
    $email = (string) $request->json('email');
    if (!isset(Personas::ALL[$email]) || !hash_equals(Personas::PASSWORD, (string) $request->json('password'))) {
        return response()->json(['title' => 'Invalid credentials'], 401);
    }

    $response = response()->json(Personas::ALL[$email]);
    $response->headers->setCookie(Personas::cookie($email));

    return $response;
});

Route::middleware(['fixture.user', 'fixture.admin'])->group(function (): void {
    Route::get('/auth/personas', fn () => response()->json(array_values(Personas::ALL)));
    Route::post('/auth/personas/{email}', function (string $email) {
        abort_unless(isset(Personas::ALL[$email]), 404);
        $response = response()->json(Personas::ALL[$email]);
        $response->headers->setCookie(Personas::cookie($email));

        return $response;
    });
});

// Items ------------------------------------------------------------------------------------

$insert = function (string $id, string $name = 'Inserted'): Item {
    abort_if(Item::query()->whereKey($id)->exists(), 409, 'Item exists');

    return Item::create(['id' => $id, 'name' => $name]);
};

Route::middleware('fixture.user')->group(function () use ($insert): void {
    Route::get('/items/{id}', fn (string $id) => response()->json(Item::query()->findOrFail($id)->only(['id', 'name'])));

    Route::post('/items/{id}/ordinary', fn (string $id) => response()->json($insert($id)->only(['id', 'name']), 201));

    Route::middleware('fixture.admin')->group(function () use ($insert): void {
        Route::post('/items', function (Request $request) use ($insert) {
            $data = $request->validate(['id' => 'required|string|max:64', 'name' => 'required|string|max:200']);
            $item = $insert($data['id'], $data['name']);
            $suppressed = Sendproof::tryRecordEmail('Created item', 'bench@example.test', ['owner@example.test'], [], 'Item ' . $item->id, 'An item was created.');
            if (!$suppressed) {
                // A real application would deliver the email here.
            }
            Log::info('created:' . $item->id);
            DB::select('select :fixture_secret as value', ['fixture_secret' => 'fixture-secret-value']);

            return response()->json($item->only(['id', 'name']), 201);
        })->sendproofPreview();

        Route::patch('/items/{id}', function (Request $request, string $id) {
            $data = $request->validate(['name' => 'required|string|max:200']);
            $item = Item::query()->findOrFail($id);
            $item->update(['name' => $data['name']]);
            $response = response()->json($item->only(['id', 'name']));
            if ($request->query('tag') !== null) {
                $response->headers->set('X-Fixture-Tag', (string) $request->query('tag'));
            }

            return $response;
        })->sendproofPreview();

        Route::delete('/items/{id}', function (string $id) {
            Item::query()->findOrFail($id)->delete();

            return response()->noContent();
        })->sendproofPreview();

        Route::post('/items/{id}/fail', function (Request $request, string $id) use ($insert) {
            $insert($id);
            if ($request->query('mode') === 'exception') {
                throw new RuntimeException('Unhandled failure after insert.');
            }

            return response()->json(['title' => 'Conflict'], 409);
        })->sendproofPreview();

        Route::post('/items/{id}/large', function (string $id) use ($insert) {
            $insert($id);

            return response(str_repeat('x', 1024 * 1024 + 1024), 200, ['Content-Type' => 'text/plain']);
        })->sendproofPreview();

        Route::post('/items/{id}/redirect', function (Request $request, string $id) use ($insert) {
            $insert($id);
            $response = response('', 302, ['Location' => $request->getBaseUrl() . '/items/' . $id]);
            $response->headers->setCookie(new Cookie('inner_cookie', 'must-not-leak'));

            return $response;
        })->sendproofPreview();

        Route::post('/items/{id}/capture', function (string $id) {
            for ($i = 0; $i < 201; $i++) {
                Item::create(['id' => $id . '-' . $i, 'name' => 'Bulk ' . $i]);
            }
            for ($i = 0; $i < 101; $i++) {
                Sendproof::tryRecordEffect('message', 'Bulk effect ' . $i, ['topic' => 'bulk', 'payload' => $i]);
            }
            for ($i = 0; $i < 501; $i++) {
                Log::info('bulk log ' . $i);
            }

            return response()->json(['id' => $id, 'name' => 'captured'], 201);
        })->sendproofPreview();
    });
});

// Shared security rules (spec/conformance/fixture.md#shared-security-rules) ---------------------

Route::middleware(['fixture.user', 'fixture.admin'])->group(function (): void {
    Route::post('/accounts', function (Request $request) {
        $data = $request->validate(['id' => 'required|string|max:64', 'email' => 'required|string', 'password' => 'required|string']);
        Account::create(['id' => $data['id'], 'email' => $data['email'], 'password_hash' => 'hashed:' . $data['password']]);

        return response()->json(['id' => $data['id'], 'email' => $data['email']], 201);
    })->sendproofPreview();

    Route::get('/accounts/{id}', function (string $id) {
        $account = Account::query()->find($id);
        abort_if($account === null, 404);

        return response()->json(['id' => $account->id, 'email' => $account->email]);
    });

    // Inserts the item, then ends the transaction the handler does not own: Preview must refuse the COMMIT.
    Route::post('/items/{id}/commit', function (Request $request, string $id) {
        $data = $request->validate(['name' => 'required|string|max:200']);
        Item::create(['id' => $id, 'name' => $data['name']]);
        DB::unprepared('COMMIT');

        return response()->json(['id' => $id, 'name' => $data['name']], 201);
    })->sendproofPreview();
});

// Data stores (spec/conformance/fixture.md#data-store-routes), present when the runner supplies them -----

if (getenv('BENCH_MONGODB_URL')) {
    $documents = fn () => DB::connection('mongodb')->table('documents');
    // The query builder reports `_id` as `id` and nested documents as arrays or objects.
    $present = static function (object|array $document): array {
        $fields = (array) $document;

        return ['id' => $fields['_id'] ?? $fields['id'], 'name' => $fields['name'], 'city' => ((array) ($fields['profile'] ?? []))['city'] ?? null];
    };

    Route::middleware(['fixture.user', 'fixture.admin'])->group(function () use ($documents, $present): void {
        Route::get('/documents/{id}', function (string $id) use ($documents, $present) {
            $document = $documents()->where('_id', $id)->first();
            abort_if($document === null, 404);

            return response()->json($present($document));
        })->sendproofPreview();

        Route::post('/documents', function (Request $request) use ($documents) {
            $data = $request->validate(['id' => 'required|string', 'name' => 'required|string', 'city' => 'required|string', 'password' => 'required|string']);
            $documents()->insert(['_id' => $data['id'], 'name' => $data['name'], 'profile' => ['city' => $data['city']], 'password_hash' => 'hashed:' . $data['password']]);
            Log::info('created-document:' . $data['id']);

            return response()->json(['id' => $data['id'], 'name' => $data['name'], 'city' => $data['city']], 201);
        })->sendproofPreview();

        Route::patch('/documents/{id}', function (Request $request, string $id) use ($documents, $present) {
            $set = array_filter(['name' => $request->json('name'), 'profile.city' => $request->json('city')], static fn ($value) => $value !== null);
            // One updateOne with $set; the Eloquent builder would send updateMany.
            $result = DB::connection('mongodb')->getCollection('documents')->updateOne(['_id' => $id], ['$set' => $set]);
            abort_if($result->getMatchedCount() === 0, 404);

            return response()->json($present($documents()->where('_id', $id)->first()));
        })->sendproofPreview();

        // $out can't run inside a transaction, so Preview blocks it before it is sent.
        Route::post('/documents/archive', function () {
            iterator_to_array(DB::connection('mongodb')->getCollection('documents')->aggregate([['$match' => new stdClass()], ['$out' => 'documents_archive']]));

            return response()->noContent();
        })->sendproofPreview();

        Route::delete('/documents/{id}', function (string $id) use ($documents) {
            $documents()->where('_id', $id)->delete();

            return response()->noContent();
        })->sendproofPreview(false, stores: ['mongodb']);
    });
}

if (getenv('BENCH_REDIS_URL')) {
    $counter = static fn (string $key): string => getenv('BENCH_REDIS_PREFIX') . 'counter:' . $key;

    Route::middleware(['fixture.user', 'fixture.admin'])->group(function () use ($counter): void {
        Route::get('/counters/{key}', function (string $key) use ($counter) {
            $value = Redis::get($counter($key));
            abort_if($value === null || $value === false, 404);

            return response()->json(['key' => $key, 'value' => (int) $value]);
        })->sendproofPreview();

        Route::post('/counters/{key}', fn (string $key) => response()->json(['key' => $key, 'value' => (int) Redis::incr($counter($key))]))->sendproofPreview();

        // GETDEL looks like a read but deletes the key. The handler swallows the refusal, and the Preview must still fail.
        Route::post('/counters/{key}/take', function (string $key) use ($counter) {
            try {
                $value = Redis::getdel($counter($key));
            } catch (\Sendproof\Core\Stores\PreviewWriteBlockedException) {
                $value = '0';
            }
            abort_if($value === null || $value === false, 404);

            return response()->json(['key' => $key, 'value' => (int) $value]);
        })->sendproofPreview();

        Route::delete('/counters/{key}', function (string $key) use ($counter) {
            Redis::del($counter($key));

            return response()->noContent();
        })->sendproofPreview(false, stores: ['redis']);
    });
}

if (getenv('BENCH_DYNAMODB_URL')) {
    $table = (string) getenv('BENCH_DYNAMODB_TABLE');
    $marshaler = new Marshaler();
    $order = static function (array $item) use ($marshaler): array {
        $item = $marshaler->unmarshalItem($item);

        return ['id' => $item['id'], 'status' => $item['status'] ?? null, 'hits' => isset($item['hits']) ? (int) $item['hits'] : null];
    };
    $touch = static fn (string $id) => app(DynamoDbClient::class)->updateItem([
        'TableName' => $table, 'Key' => ['id' => ['S' => $id]], 'UpdateExpression' => 'ADD hits :one SET #s = if_not_exists(#s, :new)',
        'ExpressionAttributeNames' => ['#s' => 'status'], 'ExpressionAttributeValues' => [':one' => ['N' => '1'], ':new' => ['S' => 'new']], 'ReturnValues' => 'ALL_NEW',
    ]);

    Route::middleware(['fixture.user', 'fixture.admin'])->group(function () use ($table, $order, $touch): void {
        Route::get('/orders/{id}', function (string $id) use ($table, $order) {
            $result = app(DynamoDbClient::class)->getItem(['TableName' => $table, 'Key' => ['id' => ['S' => $id]], 'ConsistentRead' => true]);
            abort_if(empty($result['Item']), 404);

            return response()->json($order($result['Item']));
        })->sendproofPreview();

        Route::post('/orders/{id}/touch', fn (string $id) => response()->json($order($touch($id)['Attributes'])))->sendproofPreview();

        // A PartiQL UPDATE travels through ExecuteStatement, which also carries reads.
        Route::post('/orders/{id}/cancel', function (string $id) use ($table) {
            app(DynamoDbClient::class)->executeStatement(['Statement' => "UPDATE \"{$table}\" SET status = 'cancelled' WHERE id = ?", 'Parameters' => [['S' => $id]]]);

            return response()->json(['id' => $id, 'status' => 'cancelled']);
        })->sendproofPreview();

        Route::delete('/orders/{id}', function (string $id) use ($table) {
            app(DynamoDbClient::class)->deleteItem(['TableName' => $table, 'Key' => ['id' => ['S' => $id]]]);

            return response()->noContent();
        })->sendproofPreview(false, stores: ['dynamodb']);
    });
}

// Mixed SQL and guarded store: the SQL insert rolls back with the blocked Preview.
if (getenv('BENCH_REDIS_URL') || getenv('BENCH_DYNAMODB_URL')) {
    Route::middleware(['fixture.user', 'fixture.admin'])->post('/items/{id}/remember', function (Request $request, string $id) {
        $data = $request->validate(['name' => 'required|string|max:200']);
        Item::create(['id' => $id, 'name' => $data['name']]);
        if ($request->query('store') === 'redis') {
            Redis::incr(getenv('BENCH_REDIS_PREFIX') . 'counter:item-' . $id);
        } else {
            app(DynamoDbClient::class)->updateItem([
                'TableName' => (string) getenv('BENCH_DYNAMODB_TABLE'), 'Key' => ['id' => ['S' => 'item-' . $id]],
                'UpdateExpression' => 'ADD hits :one SET #s = if_not_exists(#s, :new)', 'ExpressionAttributeNames' => ['#s' => 'status'],
                'ExpressionAttributeValues' => [':one' => ['N' => '1'], ':new' => ['S' => 'new']],
            ]);
        }

        return response()->json(['id' => $id, 'name' => $data['name']], 201);
    })->sendproofPreview();
}
