<?php

declare(strict_types=1);

return static function (bool $mysql = false): array {
    $item = ['$ref' => '#/components/schemas/Item'];
    $id = ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string']];
    $json = fn (array $schema) => ['content' => ['application/json' => ['schema' => $schema]]];
    $operation = fn (string $summary, array $extra = []) => ['summary' => $summary, 'responses' => ['200' => ['description' => 'OK']]] + $extra;
    $action = fn (string $name) => ['post' => $operation($name, ['parameters' => [$id]])];

    return [
        'openapi' => '3.1.0',
        'info' => ['title' => 'Sendproof Conformance', 'version' => '1.0.0'],
        'paths' => [
            '/items' => ['post' => $operation('Create item', ['requestBody' => ['required' => true] + $json($item), 'responses' => ['201' => ['description' => 'Created'] + $json($item)]])],
            '/items/{id}' => [
                'get' => $operation('Read item', ['operationId' => 'readItem', 'parameters' => [$id], 'responses' => ['200' => ['description' => 'OK'] + $json($item), '404' => ['description' => 'Missing']]]),
                'patch' => $operation('Rename item', ['parameters' => [$id], 'requestBody' => ['required' => true] + $json(['type' => 'object', 'required' => ['name'], 'properties' => ['name' => ['type' => 'string']]])]),
                'delete' => $operation('Delete item', ['parameters' => [$id], 'responses' => ['204' => ['description' => 'Deleted']]]),
            ],
            '/items/{id}/fail' => $action('Fail after insert'),
            '/items/{id}/large' => $action('Oversized response'),
            '/items/{id}/redirect' => $action('Redirect with cookie'),
            '/items/{id}/capture' => $action('Exceed capture limits'),
            '/items/{id}/ordinary' => $action('Send only'),
            '/items/{id}/commit' => $action('Insert then COMMIT'),
            ...($mysql ? ['/items/{id}/escape' => $action('Insert, then commit implicitly (DDL or CALL)')] : []),
            '/accounts' => ['post' => $operation('Create account')],
            '/accounts/{id}' => ['get' => $operation('Read account', ['parameters' => [$id]])],
            '/items/{id}/remember' => $action('Insert, then write a guarded store'),
            '/documents' => ['post' => $operation('Create document')],
            '/documents/archive' => ['post' => $operation('Archive documents')],
            '/documents/{id}' => [
                'get' => $operation('Read document', ['parameters' => [$id]]),
                'patch' => $operation('Update document', ['parameters' => [$id]]),
                'delete' => $operation('Delete document', ['parameters' => [$id]]),
            ],
            '/counters/{key}' => [
                'get' => $operation('Read counter', ['parameters' => [$id]]),
                'post' => $operation('Increment counter', ['parameters' => [$id]]),
                'delete' => $operation('Delete counter', ['parameters' => [$id]]),
            ],
            '/counters/{key}/take' => $action('Take counter'),
            '/orders/{id}' => [
                'get' => $operation('Read order', ['parameters' => [$id]]),
                'delete' => $operation('Delete order', ['parameters' => [$id]]),
            ],
            '/orders/{id}/touch' => $action('Touch order'),
            '/orders/{id}/cancel' => $action('Cancel order'),
        ],
        'components' => ['schemas' => ['Item' => [
            'type' => 'object', 'required' => ['id', 'name'],
            'properties' => ['id' => ['type' => 'string'], 'name' => ['type' => 'string']],
        ]]],
    ];
};
