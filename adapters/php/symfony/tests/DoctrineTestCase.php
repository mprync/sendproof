<?php

declare(strict_types=1);

namespace TestBench\Symfony\Tests;

use Doctrine\DBAL\Connection;
use Doctrine\DBAL\DriverManager;
use Doctrine\ORM\EntityManager;
use Doctrine\ORM\ORMSetup;
use PHPUnit\Framework\TestCase;
use TestBench\Core\Capture\Recorder;
use TestBench\Symfony\Doctrine\CaptureMiddleware;
use TestBench\Symfony\Doctrine\OrmChangeCollector;

/** A real SQLite file, a real DBAL connection with the capture middleware, and a real ORM. */
abstract class DoctrineTestCase extends TestCase
{
    protected Connection $connection;
    protected EntityManager $em;
    protected Recorder $recorder;
    protected OrmChangeCollector $collector;
    private string $file;

    protected function setUp(): void
    {
        $this->file = sys_get_temp_dir() . '/testbench-symfony-' . bin2hex(random_bytes(4)) . '.sqlite';
        $this->recorder = new Recorder();
        $this->collector = new OrmChangeCollector();

        $configuration = ORMSetup::createAttributeMetadataConfiguration([__DIR__ . '/Entity'], true);
        // PHP 8.4 native lazy objects: no proxy generation or symfony/var-exporter needed.
        $configuration->enableNativeLazyObjects(true);
        $configuration->setMiddlewares([new CaptureMiddleware($this->recorder, true, 'test')]);
        $this->connection = DriverManager::getConnection(['driver' => 'pdo_sqlite', 'path' => $this->file], $configuration);
        $this->connection->executeStatement('create table widgets (id varchar(64) primary key not null, name varchar(255) not null, api_token varchar(255) null)');

        $this->em = new EntityManager($this->connection, $configuration);
        $this->em->getEventManager()->addEventListener(['onFlush', 'postFlush'], $this->collector);
    }

    protected function tearDown(): void
    {
        $this->em->close();
        $this->connection->close();
        @unlink($this->file);
    }

    protected function rowCount(): int
    {
        return (int) $this->connection->fetchOne('select count(*) from widgets');
    }
}
