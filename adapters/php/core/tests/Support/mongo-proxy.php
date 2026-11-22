<?php

declare(strict_types=1);

/*
 * A TCP proxy to the compose MongoDB that a test can cut: the network failing between a Preview's
 * handler and its abort. Run it as `php mongo-proxy.php <host> <port>`. It prints
 * "<proxy port> <control port>\n" and serves until its standard input closes.
 *
 * A client of the control port sends "cut <seconds>\n": every open connection is closed, new ones
 * are closed as soon as they are accepted, and the proxy answers "ok\n". After <seconds> it lets
 * connections through again.
 */

[, $host, $port] = $argv;
$listener = stream_socket_server('tcp://127.0.0.1:0', $errno, $error) ?: throw new RuntimeException($error);
$control = stream_socket_server('tcp://127.0.0.1:0', $errno, $error) ?: throw new RuntimeException($error);
$portOf = static fn ($socket): string => substr(strrchr(stream_socket_get_name($socket, false), ':'), 1);
echo $portOf($listener), ' ', $portOf($control), "\n";
fflush(STDOUT);

/** @var array<int,resource> $peers each linked socket's other end, by socket id */
$peers = [];
$sockets = [];
/** @var array<int,resource> $commands open control connections */
$commands = [];
$downUntil = 0.0;
$close = static function ($socket) use (&$peers, &$sockets): void {
    $id = (int) $socket;
    unset($peers[$id], $sockets[$id]);
    @fclose($socket);
};
$cut = static function () use (&$peers, &$sockets, $close): void {
    foreach ($sockets as $socket) {
        $close($socket);
    }
    $peers = [];
    $sockets = [];
};

while (true) {
    $read = [$listener, $control, STDIN, ...array_values($commands), ...array_values($sockets)];
    $write = $except = null;
    if (@stream_select($read, $write, $except, 0, 50_000) === false) {
        continue;
    }
    foreach ($read as $socket) {
        if ($socket === STDIN) {
            if (fgets(STDIN) === false) {
                exit(0);
            }
        } elseif ($socket === $listener) {
            $downstream = @stream_socket_accept($listener, 0);
            if ($downstream === false) {
                continue;
            }
            if (microtime(true) < $downUntil) {
                fclose($downstream);
                continue;
            }
            $upstream = @stream_socket_client("tcp://{$host}:{$port}", $errno, $error, 2);
            if ($upstream === false) {
                fclose($downstream);
                continue;
            }
            $peers[(int) $downstream] = $upstream;
            $peers[(int) $upstream] = $downstream;
            $sockets[(int) $downstream] = $downstream;
            $sockets[(int) $upstream] = $upstream;
        } elseif ($socket === $control) {
            if (($connection = @stream_socket_accept($control, 0)) !== false) {
                $commands[(int) $connection] = $connection;
            }
        } elseif (isset($commands[(int) $socket])) {
            $line = fgets($socket);
            if ($line === false) {
                unset($commands[(int) $socket]);
                fclose($socket);
            } elseif (preg_match('/^cut ([0-9.]+)/', $line, $match) === 1) {
                $downUntil = microtime(true) + (float) $match[1];
                $cut();
                fwrite($socket, "ok\n");
            }
        } elseif (isset($sockets[(int) $socket])) {
            $peer = $peers[(int) $socket] ?? null;
            $data = @fread($socket, 65536);
            if ($data === false || ($data === '' && feof($socket)) || $peer === null) {
                $close($socket);
                if ($peer !== null) {
                    $close($peer);
                }
                continue;
            }
            if ($data !== '' && @fwrite($peer, $data) === false) {
                $close($socket);
                $close($peer);
            }
        }
    }
}
