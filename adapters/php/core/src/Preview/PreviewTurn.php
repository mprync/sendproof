<?php

declare(strict_types=1);

namespace Sendproof\Core\Preview;

/**
 * One Preview's turn on a database, held until {@see release()} or until the object is destroyed.
 *
 * MySQL and MariaDB deadlock (error 1213) when three or more transactions insert the same new key
 * and the first rolls back, as every Preview does, at every isolation level. Previews on such a
 * database therefore take turns. See {@see PreviewTurns}.
 */
final class PreviewTurn
{
    /** @param resource|null $handle */
    public function __construct(private $handle)
    {
    }

    /** Hands the turn to the next waiting Preview. Safe to call more than once. */
    public function release(): void
    {
        if ($this->handle === null) {
            return;
        }
        flock($this->handle, LOCK_UN);
        fclose($this->handle);
        $this->handle = null;
    }

    public function __destruct()
    {
        $this->release();
    }
}
