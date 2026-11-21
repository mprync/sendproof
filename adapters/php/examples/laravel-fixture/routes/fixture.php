<?php

declare(strict_types=1);

use Fixture\Models\Item;
use Fixture\Support\Personas;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
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
