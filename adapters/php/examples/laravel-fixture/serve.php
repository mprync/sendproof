<?php

/**
 * Starts the conformance fixture on loopback.
 *
 * Reads PORT, BENCH_PATH_BASE and BENCH_SCENARIO from the environment, creates the fixture tables
 * in an empty SQLite database for this process (or in the fresh MySQL database the runner supplies
 * through BENCH_DATABASE_URL), then replaces itself with `php -S` so the runner's process-group
 * signals stop the server. The data-store variables (BENCH_MONGODB_URL, BENCH_REDIS_URL,
 * BENCH_DYNAMODB_URL and their companions) pass through to the application untouched.
 */

declare(strict_types=1);

$port = (int) (getenv('PORT') ?: 5361);
$scenario = getenv('BENCH_SCENARIO') ?: 'standard';
$directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'sendproof-php-fixture-' . $port;

// A new process always starts with an empty table and no stored traces.
if (is_dir($directory)) {
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $entry) {
        $entry->isDir() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
    }
}
mkdir($directory . '/storage/framework', 0700, true);
$mysql = (getenv('BENCH_DATABASE') ?: 'sqlite') === 'mysql' ? parse_url((string) getenv('BENCH_DATABASE_URL')) : null;
$database = $directory . '/fixture.sqlite';
if ($mysql !== null) {
    $pdo = new PDO(
        sprintf('mysql:host=%s;port=%d;dbname=%s', $mysql['host'], $mysql['port'] ?? 3306, ltrim($mysql['path'], '/')),
        rawurldecode($mysql['user'] ?? 'root'),
        rawurldecode($mysql['pass'] ?? ''),
    );
    $pdo->exec('create table items (id varchar(191) primary key not null, name varchar(255) not null)');
    $pdo->exec('create table accounts (id varchar(191) primary key not null, email varchar(255) not null, password_hash varchar(255) not null)');
} else {
    $pdo = new PDO('sqlite:' . $database);
    $pdo->exec('create table items (id text primary key not null, name text not null)');
    $pdo->exec('create table accounts (id text primary key not null, email text not null, password_hash text not null)');
}
$pdo = null;

$environment = [
    'PORT' => (string) $port,
    'BENCH_SCENARIO' => $scenario,
    'BENCH_PATH_BASE' => getenv('BENCH_PATH_BASE') ?: '',
    'FIXTURE_DIR' => $directory,
    'APP_NAME' => 'Sendproof Conformance',
    'APP_KEY' => 'base64:' . base64_encode(random_bytes(32)),
    'APP_ENV' => $scenario === 'disabled' ? 'production' : 'local',
    'APP_DEBUG' => 'false',
    'DB_CONNECTION' => $mysql !== null ? 'mysql' : 'sqlite',
    'DB_DATABASE' => $mysql !== null ? ltrim($mysql['path'], '/') : $database,
    ...($mysql === null ? [] : [
        'DB_HOST' => $mysql['host'], 'DB_PORT' => (string) ($mysql['port'] ?? 3306),
        'DB_USERNAME' => rawurldecode($mysql['user'] ?? 'root'), 'DB_PASSWORD' => rawurldecode($mysql['pass'] ?? ''),
    ]),
    'CACHE_STORE' => 'array',
    'SESSION_DRIVER' => 'array',
    'QUEUE_CONNECTION' => 'sync',
    'MAIL_MAILER' => 'array',
    // Silent by default; BENCH_LOG_CHANNEL=stderr shows why a request failed.
    'LOG_CHANNEL' => getenv('BENCH_LOG_CHANNEL') ?: 'null',
    'SENDPROOF_ENABLED' => 'true',
    'SENDPROOF_ENVIRONMENTS' => 'local',
    'SENDPROOF_TRACE_TTL' => getenv('SENDPROOF_TRACE_TTL') ?: '5',
    // SQLite is one file with one writer, so it keeps one worker. MySQL gets several workers, which is
    // what lets the concurrency check hit the Preview turn lock the way separate FPM workers would.
    'PHP_CLI_SERVER_WORKERS' => $mysql !== null ? '8' : '1',
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
