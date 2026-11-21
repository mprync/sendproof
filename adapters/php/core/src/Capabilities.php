<?php

declare(strict_types=1);

namespace TestBench\Core;

/** Builds the protocol v1 discovery document. */
final class Capabilities
{
    /**
     * @param list<array{name:string,url:string}> $documents
     * @param list<string> $fieldModules
     * @param list<array{label:string,kind:string,url:?string}> $authProviders
     * @param list<array{method:string,path:string}> $previewOperations
     * @param array{name:?string,role?:?string}|null $identity
     * @return array<string,mixed>
     */
    public static function build(
        string $apiName,
        string $environment,
        string $openApiUrl,
        array $documents,
        array $fieldModules,
        ?string $database,
        ?array $identity,
        array $authProviders,
        array $previewOperations,
    ): array {
        if (!array_filter($documents, static fn (array $document): bool => $document['url'] === $openApiUrl)) {
            array_unshift($documents, ['name' => $apiName, 'url' => $openApiUrl]);
        }

        $capabilities = [
            'protocolVersion' => 1,
            'openApiUrl' => $openApiUrl,
        ];
        if ($fieldModules !== []) {
            $capabilities['fieldModules'] = array_values($fieldModules);
        }
        if ($identity !== null && ($identity['role'] ?? null) === null) {
            unset($identity['role']);
        }

        return $capabilities + [
            'apiName' => $apiName,
            'environment' => $environment,
            'database' => $database,
            'identity' => $identity,
            'authProviders' => $authProviders,
            'previewOperations' => $previewOperations,
            'observedSend' => $previewOperations !== [],
            'documents' => $documents,
        ];
    }

    /**
     * Prefixes a configured application-relative URL with the path base after validating it.
     *
     * Discovery advertises these URLs to the browser, which loads field modules as scripts and
     * follows sign-in links, so only same-origin paths are accepted.
     *
     * @throws \InvalidArgumentException when `$url` is not an application-relative path
     */
    public static function withBase(string $pathBase, string $url): string
    {
        if (!self::isLocalUrl($url)) {
            throw new \InvalidArgumentException('Test Bench URLs must be application-relative paths such as /openapi/v1.json.');
        }

        return $pathBase . $url;
    }

    /** True for an application-relative, same-origin path such as `/auth/sign-in`. */
    public static function isLocalUrl(string $url): bool
    {
        $path = explode('?', $url, 2)[0];
        $decoded = rawurldecode($path);

        return str_starts_with($path, '/') && !str_starts_with($decoded, '//')
            && !str_contains($url, '#') && !str_contains($url, '\\') && !str_contains($decoded, '\\')
            && !preg_match('/[\s\x00-\x1f\x7f]/', $url) && !preg_match('/[\x00-\x1f\x7f]/', $decoded)
            && !in_array('..', explode('/', $decoded), true) && !in_array('.', explode('/', $decoded), true);
    }
}
