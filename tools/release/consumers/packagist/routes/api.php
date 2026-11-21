<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;

Route::get('/openapi.json', fn () => response()->json([
    'openapi' => '3.1.0',
    'info' => ['title' => 'Packagist consumer', 'version' => '1.0.0'],
    'paths' => [
        '/ping' => ['get' => ['summary' => 'Ping', 'responses' => ['200' => ['description' => 'OK']]]],
    ],
]));

Route::get('/ping', fn () => response()->json(['ok' => true]));
