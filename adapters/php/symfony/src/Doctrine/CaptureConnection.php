<?php

declare(strict_types=1);

namespace TestBench\Symfony\Doctrine;

use Doctrine\DBAL\Driver\Connection as ConnectionInterface;
use Doctrine\DBAL\Driver\Middleware\AbstractConnectionMiddleware;
use Doctrine\DBAL\Driver\Result;
use Doctrine\DBAL\Driver\Statement as StatementInterface;
use TestBench\Core\Capture\Recorder;
use TestBench\Core\Capture\SqlRedactor;

/** Records statements that run without prepared parameters, and wraps prepared ones. */
final class CaptureConnection extends AbstractConnectionMiddleware
{
    private const CATEGORY = 'Doctrine.DBAL.Connection';

    public function __construct(ConnectionInterface $connection, private readonly Recorder $recorder, private readonly bool $showValues)
    {
        parent::__construct($connection);
    }

    public function prepare(string $sql): StatementInterface
    {
        return new CaptureStatement(parent::prepare($sql), $sql, $this->recorder, $this->showValues);
    }

    public function query(string $sql): Result
    {
        $started = hrtime(true);
        $result = parent::query($sql);
        $this->record($sql, $started, null);

        return $result;
    }

    public function exec(string $sql): int|string
    {
        $started = hrtime(true);
        $affected = parent::exec($sql);
        $this->record($sql, $started, is_int($affected) ? $affected : null);

        return $affected;
    }

    private function record(string $sql, int $started, ?int $rows): void
    {
        if (!$this->recorder->isCapturing() || self::isSavepoint($sql)) {
            return;
        }
        [$entry, $truncated] = SqlRedactor::entry($sql, [], $this->showValues, $rows);
        $this->recorder->recordSql((hrtime(true) - $started) / 1e6, $entry, $truncated, self::CATEGORY);
    }

    /** Whether the statement is a savepoint command Doctrine issues for nested transactions. */
    public static function isSavepoint(string $sql): bool
    {
        return (bool) preg_match('/^\s*(?:release\s+|rollback\s+to\s+)?savepoint\b/i', $sql);
    }
}
