<?php

declare(strict_types=1);

namespace Sendproof\Symfony\Doctrine;

use Doctrine\DBAL\Driver as DriverInterface;
use Doctrine\DBAL\Driver\Connection as ConnectionInterface;
use Doctrine\DBAL\Driver\Middleware\AbstractDriverMiddleware;
use Sendproof\Core\Capture\Recorder;

/** Wraps each new driver connection so its statements are captured. */
final class CaptureDriver extends AbstractDriverMiddleware
{
    public function __construct(DriverInterface $driver, private readonly Recorder $recorder, private readonly bool $showValues)
    {
        parent::__construct($driver);
    }

    public function connect(#[\SensitiveParameter] array $params): ConnectionInterface
    {
        return new CaptureConnection(parent::connect($params), $this->recorder, $this->showValues, in_array($params['driver'] ?? '', ['pdo_mysql', 'mysqli'], true));
    }
}
