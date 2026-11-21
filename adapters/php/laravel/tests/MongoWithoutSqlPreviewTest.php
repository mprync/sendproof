<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

/** The same checks for an application whose only database is MongoDB: no SQL provider, and Previews still roll back. */
final class MongoWithoutSqlPreviewTest extends MongoPreviewTest
{
    protected function sqlProvider(): ?string
    {
        return null;
    }

    public function testDiscoveryReportsNoSqlDatabaseButStillOffersPreview(): void
    {
        $this->signIn();
        $capabilities = $this->capabilities();
        $this->assertNull($capabilities['database']);
        $this->assertContains(['method' => 'POST', 'path' => '/documents'], $capabilities['previewOperations']);
        $this->assertTrue($capabilities['observedSend']);
    }
}
