<?php

declare(strict_types=1);

namespace Fixture\Support;

use Sendproof\Symfony\SendproofManager;

final class RegisterJourneys
{
    public function __invoke(SendproofManager $sendproof): void
    {
        $journeys = dirname(__DIR__, 3) . '/journeys/';
        $openApi = require $journeys . 'openapi.php';
        $sendproof->addJourneys(require $journeys . 'conformance.php', $openApi());
    }
}
