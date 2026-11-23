<?php

declare(strict_types=1);

namespace Fixture\Controller;

use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

/** Readiness probe and the OpenAPI document the workbench discovers. */
final class MetaController
{
    #[Route('/ready', methods: ['GET'])]
    public function ready(): Response
    {
        return new Response('ok');
    }

    #[Route('/openapi/v1.json', methods: ['GET'])]
    public function openApi(): Response
    {
        $document = require dirname(__DIR__, 3) . '/journeys/openapi.php';

        return new JsonResponse($document());
    }
}
