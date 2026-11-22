<?php

declare(strict_types=1);

namespace Fixture\Support;

use OpenSearch\Client;
use OpenSearch\ClientBuilder;

/**
 * Builds the fixture's OpenSearch client with the legacy `ClientBuilder` (RingPHP transport). The
 * Laravel fixture uses the PSR-18 transport, so the two entries between them cover both ways
 * opensearch-php 2 sends.
 */
final class OpenSearchFactory
{
    public static function create(string $url): Client
    {
        return ClientBuilder::create()->setHosts([$url])->build();
    }
}
