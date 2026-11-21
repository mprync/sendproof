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
        $item = ['$ref' => '#/components/schemas/Item'];
        $id = ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string']];
        $json = static fn (array $schema): array => ['content' => ['application/json' => ['schema' => $schema]]];
        $operation = static fn (string $summary, array $extra = []): array => ['summary' => $summary, 'responses' => ['200' => ['description' => 'OK']]] + $extra;
        $action = static fn (string $name): array => ['post' => $operation($name, ['parameters' => [$id]])];

        return new JsonResponse([
            'openapi' => '3.1.0',
            'info' => ['title' => 'Test Bench Conformance', 'version' => '1.0.0'],
            'paths' => [
                '/items' => ['post' => $operation('Create item', ['requestBody' => ['required' => true] + $json($item), 'responses' => ['201' => ['description' => 'Created'] + $json($item)]])],
                '/items/{id}' => [
                    'get' => $operation('Read item', ['parameters' => [$id], 'responses' => ['200' => ['description' => 'OK'] + $json($item), '404' => ['description' => 'Missing']]]),
                    'patch' => $operation('Rename item', ['parameters' => [$id], 'requestBody' => ['required' => true] + $json(['type' => 'object', 'required' => ['name'], 'properties' => ['name' => ['type' => 'string']]])]),
                    'delete' => $operation('Delete item', ['parameters' => [$id], 'responses' => ['204' => ['description' => 'Deleted']]]),
                ],
                '/items/{id}/fail' => $action('Fail after insert'),
                '/items/{id}/large' => $action('Oversized response'),
                '/items/{id}/redirect' => $action('Redirect with cookie'),
                '/items/{id}/capture' => $action('Exceed capture limits'),
                '/items/{id}/ordinary' => $action('Send only'),
            ],
            'components' => ['schemas' => ['Item' => [
                'type' => 'object', 'required' => ['id', 'name'],
                'properties' => ['id' => ['type' => 'string'], 'name' => ['type' => 'string']],
            ]]],
        ]);
    }
}
