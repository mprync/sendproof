<?php

/**
 * Starts the conformance fixture on loopback.
 *
 * Reads PORT, BENCH_PATH_BASE and BENCH_SCENARIO from the environment, creates an empty SQLite
 * database for this process, then replaces itself with `php -S` so the runner's process-group
 * signals stop the server.
 */

declare(strict_types=1);

$port = (int) (getenv('PORT') ?: 5361);
$scenario = getenv('BENCH_SCENARIO') ?: 'standard';
$directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'testbench-php-fixture-' . $port;

// A new process always starts with an empty table and no stored traces.
if (is_dir($directory)) {
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $entry) {
        $entry->isDir() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
    }
}
mkdir($directory . '/storage/framework', 0700, true);
$database = $directory . '/fixture.sqlite';
$pdo = new PDO('sqlite:' . $database);
$pdo->exec('create table items (id text primary key not null, name text not null)');
$pdo = null;

$environment = [
    'PORT' => (string) $port,
    'BENCH_SCENARIO' => $scenario,
    'BENCH_PATH_BASE' => getenv('BENCH_PATH_BASE') ?: '',
    'FIXTURE_DIR' => $directory,
    'APP_NAME' => 'Test Bench Conformance',
    'APP_KEY' => 'base64:' . base64_encode(random_bytes(32)),
    'APP_ENV' => $scenario === 'disabled' ? 'production' : 'local',
    'APP_DEBUG' => 'false',
    'DB_CONNECTION' => 'sqlite',
    'DB_DATABASE' => $database,
    'CACHE_STORE' => 'array',
    'SESSION_DRIVER' => 'array',
    'QUEUE_CONNECTION' => 'sync',
    'MAIL_MAILER' => 'array',
    'LOG_CHANNEL' => 'null',
    'TESTBENCH_ENABLED' => 'true',
    'TESTBENCH_ENVIRONMENTS' => 'local',
    'TESTBENCH_TRACE_TTL' => getenv('TESTBENCH_TRACE_TTL') ?: '5',
    'PHP_CLI_SERVER_WORKERS' => '1',
];
$arguments = [PHP_BINARY, '-d', 'memory_limit=512M', '-S', "127.0.0.1:{$port}", __DIR__ . '/router.php'];
$merged = array_merge(getenv(), $environment);

if (function_exists('pcntl_exec')) {
    chdir(__DIR__ . '/public');
    pcntl_exec(PHP_BINARY, array_slice($arguments, 1), $merged);
    fwrite(STDERR, "Cannot start php -S\n");
    exit(1);
}

foreach ($environment as $name => $value) {
    putenv("{$name}={$value}");
}
chdir(__DIR__ . '/public');
passthru(implode(' ', array_map('escapeshellarg', $arguments)), $code);
exit($code);
