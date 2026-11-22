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
 *
 * "drop-aborts\n" makes the proxy read the driver's requests message by message and close the
 * connection on any request whose OP_MSG body starts with abortTransaction, instead of forwarding
 * it: only the abort is lost, and everything else still gets through. It answers "ok\n".
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
$dropAborts = false;
/** @var array<int,string> $requests bytes read from each driver-side socket, not yet forwarded */
$requests = [];
$close = static function ($socket) use (&$peers, &$sockets, &$requests): void {
    $id = (int) $socket;
    unset($peers[$id], $sockets[$id], $requests[$id]);
    @fclose($socket);
};
/** The first key of an OP_MSG's body section (kind 0): the command name. */
$commandName = static function (string $message): ?string {
    if (strlen($message) <= 26 || unpack('V', $message, 12)[1] !== 2013 || ord($message[20]) !== 0) {
        return null;
    }

    return substr($message, 26, strcspn($message, "\0", 26));
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
            $requests[(int) $downstream] = '';
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
            } elseif (str_starts_with($line, 'drop-aborts')) {
                $dropAborts = true;
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
            if (isset($requests[(int) $socket])) {
                // From the driver: forward whole messages, and lose any abortTransaction when asked to.
                $buffer = $requests[(int) $socket] . $data;
                $data = '';
                while (strlen($buffer) >= 4 && strlen($buffer) >= ($length = unpack('V', $buffer)[1])) {
                    $message = substr($buffer, 0, $length);
                    $buffer = substr($buffer, $length);
                    if ($dropAborts && $commandName($message) === 'abortTransaction') {
                        $close($socket);
                        $close($peer);
                        continue 2;
                    }
                    $data .= $message;
                }
                $requests[(int) $socket] = $buffer;
            }
            if ($data !== '' && @fwrite($peer, $data) === false) {
                $close($socket);
                $close($peer);
            }
        }
    }
}
