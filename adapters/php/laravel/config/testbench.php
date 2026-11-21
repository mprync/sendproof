<?php

declare(strict_types=1);

/*
 * Test Bench configuration.
 *
 * The workbench is opt-in. It is mounted only when `enabled` is true AND the application
 * environment is listed in `environments`. Production is never listed by default.
 */
return [
    // Master switch. Nothing is mounted and previews are refused unless this is true.
    'enabled' => (bool) env('TESTBENCH_ENABLED', false),

    // Application environments (APP_ENV) where the workbench may run.
    'environments' => array_values(array_filter(array_map('trim', explode(',', (string) env('TESTBENCH_ENVIRONMENTS', 'local'))))),

    // Display name in the workbench. Defaults to the application name.
    'api_name' => env('TESTBENCH_API_NAME'),

    // Application-relative URL of the OpenAPI document, plus any additional documents.
    'openapi_url' => '/openapi/v1.json',
    'documents' => [], // [['name' => 'Inventory', 'url' => '/openapi/v1.json']]

    // Same-origin ES modules that add custom field renderers. Host configuration only.
    'field_modules' => [],

    // Sign-in methods advertised to the workbench: [['label' => 'Staff', 'kind' => 'oidc', 'url' => '/login']]
    'auth_providers' => [],

    // Middleware for the /bench routes. Null uses the `web` group when the application defines one.
    'middleware' => null,

    // Gate ability required to open the workbench and to preview or observe operations. Null = no extra check.
    'authorize' => null,

    // Auth guard used to resolve the signed-in user. Null uses the default guard.
    'guard' => null,

    // 'eloquent' (default), null to disable previews, or a class implementing PreviewProvider.
    'provider' => 'eloquent',

    // Database connections enrolled in a preview. Null is the default connection. Add every
    // connection a previewed operation writes to; unlisted connections are NOT rolled back.
    'connections' => [null],

    // Display label for the database. Defaults to the connection's database name without its path.
    'database_label' => env('TESTBENCH_DATABASE_LABEL'),

    // Show SQL parameter values. Null shows them in local, development and testing only.
    'include_sql_parameter_values' => null,

    'trace' => [
        // How long an observed send trace can be read, in seconds.
        'ttl' => (int) env('TESTBENCH_TRACE_TTL', 300),
        'per_owner' => 8,
        'total' => 32,
        // Private directory for traces. Defaults to storage/framework/testbench-traces.
        'path' => null,
    ],

    // Directory holding the embedded UI bundle (manifest.json plus assets). Defaults to the package copy.
    'ui_path' => null,
];
