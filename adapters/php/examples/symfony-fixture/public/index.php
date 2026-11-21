<?php

declare(strict_types=1);

use Fixture\Kernel;
use Symfony\Component\HttpFoundation\Request;

require __DIR__ . '/../vendor/autoload.php';

// Serve the app under a path prefix such as /tenant. Requests outside it are not part of the app.
$base = rtrim((string) getenv('BENCH_PATH_BASE'), '/');
$path = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if ($base !== '' && $path !== $base && !str_starts_with($path, $base . '/')) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo 'Not found';
    return;
}
$_SERVER['SCRIPT_NAME'] = $_SERVER['PHP_SELF'] = $base . '/index.php';
$_SERVER['SCRIPT_FILENAME'] = __FILE__;

$kernel = new Kernel((string) (getenv('APP_ENV') ?: 'dev'), filter_var(getenv('APP_DEBUG'), FILTER_VALIDATE_BOOLEAN));
$request = Request::createFromGlobals();
$response = $kernel->handle($request);
$response->send();
$kernel->terminate($request, $response);
