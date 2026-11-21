<?php

/**
 * Starts the Symfony conformance fixture on loopback.
 *
 * Reads PORT, BENCH_PATH_BASE and BENCH_SCENARIO from the environment, creates empty SQLite tables
 * for this process (the data-store variables, BENCH_MONGODB_URL and the rest, pass through untouched), then replaces itself with `php -S` so the runner's process-group
 * signals stop the server. The `disabled` scenario runs in the `prod` environment.
 */

declare(strict_types=1);

$port = (int) (getenv('PORT') ?: 5374);
$scenario = getenv('BENCH_SCENARIO') ?: 'standard';
$directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'sendproof-symfony-fixture-' . $port;

// A new process always starts with an empty table, no stored traces and a cold container cache.
if (is_dir($directory)) {
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $entry) {
        $entry->isDir() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
    }
}
mkdir($directory, 0700, true);
$database = $directory . '/fixture.sqlite';
$pdo = new PDO('sqlite:' . $database);
$pdo->exec('create table items (id varchar(255) primary key not null, name varchar(255) not null)');
$pdo->exec('create table accounts (id varchar(255) primary key not null, email varchar(255) not null, password_hash varchar(255) not null)');
$pdo = null;

$environment = [
    'PORT' => (string) $port,
    'BENCH_SCENARIO' => $scenario,
    'BENCH_PATH_BASE' => getenv('BENCH_PATH_BASE') ?: '',
    'FIXTURE_DIR' => $directory,
    'APP_ENV' => $scenario === 'disabled' ? 'prod' : 'dev',
    'APP_DEBUG' => '0',
    'DB_DATABASE' => $database,
    'SENDPROOF_TRACE_TTL' => getenv('SENDPROOF_TRACE_TTL') ?: '5',
    'PHP_CLI_SERVER_WORKERS' => '1',
];
$arguments = [PHP_BINARY, '-d', 'memory_limit=512M', '-S', "127.0.0.1:{$port}", __DIR__ . '/router.php'];

if (function_exists('pcntl_exec')) {
    chdir(__DIR__ . '/public');
    pcntl_exec(PHP_BINARY, array_slice($arguments, 1), array_merge(getenv(), $environment));
    fwrite(STDERR, "Cannot start php -S\n");
    exit(1);
}

foreach ($environment as $name => $value) {
    putenv("{$name}={$value}");
}
chdir(__DIR__ . '/public');
passthru(implode(' ', array_map('escapeshellarg', $arguments)), $code);
exit($code);
