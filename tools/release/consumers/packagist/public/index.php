<?php

declare(strict_types=1);

use Illuminate\Http\Request;

define('LARAVEL_START', microtime(true));
require __DIR__ . '/../vendor/autoload.php';

// Used as the `php -S` router script, so the built-in server reports the request path as SCRIPT_NAME.
$_SERVER['SCRIPT_NAME'] = $_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = __FILE__;

/** @var Illuminate\Foundation\Application $app */
$app = require_once __DIR__ . '/../bootstrap/app.php';
$app->handleRequest(Request::capture());
