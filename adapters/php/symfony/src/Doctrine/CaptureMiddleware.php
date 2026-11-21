<?php

declare(strict_types=1);

namespace TestBench\Symfony\Doctrine;

use Doctrine\DBAL\Driver as DriverInterface;
use Doctrine\DBAL\Driver\Middleware;
use TestBench\Core\Capture\Recorder;

/**
 * DBAL middleware that reports every executed statement to the request's recorder.
 *
 * It wraps the driver, so it sees statements from the ORM, the query builder and raw SQL alike,
 * including affected row counts for writes. It does nothing unless a preview or observed send is
 * capturing. Savepoint statements issued for nested transactions are left out.
 */
final class CaptureMiddleware implements Middleware
{
    /** @param bool|null $showValues Null shows values in `dev` and `test` only */
    public function __construct(
        private readonly Recorder $recorder,
        private readonly ?bool $showValues,
        private readonly string $environment,
    ) {
    }

    public function wrap(DriverInterface $driver): DriverInterface
    {
        return new CaptureDriver($driver, $this->recorder, $this->showValues ?? in_array($this->environment, ['dev', 'test'], true));
    }
}
