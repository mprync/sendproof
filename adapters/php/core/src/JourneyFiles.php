<?php

declare(strict_types=1);

namespace Sendproof\Core;

/** Serves only host-registered JSON files. Request paths are never used to open a file. */
final class JourneyFiles
{
    public const ROUTE_FILE = '[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:arazzo|expect)\.json';

    /** @var array<string,array{name:string,arazzo:\stdClass,expectations:\stdClass}> */
    private array $documents = [];

    /** @param list<string> $paths */
    public function __construct(array $paths)
    {
        foreach ($paths as $path) {
            $file = basename($path);
            if (!preg_match('/^([a-zA-Z0-9][a-zA-Z0-9._-]*)\.arazzo\.json$/D', $file, $match)) {
                throw new \InvalidArgumentException("Invalid Arazzo filename: {$file}.");
            }
            $stem = $match[1];
            if (isset($this->documents[$stem])) {
                throw new \InvalidArgumentException("Duplicate Arazzo filename: {$file}.");
            }

            $arazzo = self::read($path);
            $name = $arazzo->info->title ?? null;
            if (($arazzo->arazzo ?? null) !== '1.1.0' || !is_string($name) || trim($name) === '') {
                throw new \InvalidArgumentException("Expected an Arazzo 1.1.0 document with a title in {$file}.");
            }
            $expectPath = dirname($path) . DIRECTORY_SEPARATOR . $stem . '.expect.json';
            $expectations = file_exists($expectPath) ? self::read($expectPath) : (object) [
                'sendproofExpectations' => '1.0',
                'arazzo' => $file,
                'journeys' => new \stdClass(),
            ];
            if (($expectations->sendproofExpectations ?? null) !== '1.0'
                || ($expectations->arazzo ?? null) !== $file
                || !(($expectations->journeys ?? null) instanceof \stdClass)) {
                throw new \InvalidArgumentException("Invalid expectations for {$file}.");
            }
            $this->documents[$stem] = ['name' => $name, 'arazzo' => $arazzo, 'expectations' => $expectations];
        }
    }

    /** @return list<array{name:string,source:string,arazzoUrl:string,expectationsUrl:string}> */
    public function discovery(string $pathBase): array
    {
        $entries = [];
        foreach ($this->documents as $stem => $document) {
            $path = $pathBase . '/sendproof/journeys/' . $stem;
            $entries[] = [
                'name' => $document['name'],
                'source' => 'file',
                'arazzoUrl' => $path . '.arazzo.json',
                'expectationsUrl' => $path . '.expect.json',
            ];
        }

        return $entries;
    }

    /** Resolves a registered document and serves local source URLs under the request's path base. */
    public function json(string $file, string $pathBase): ?string
    {
        if (!preg_match('/^(.+)\.(arazzo|expect)\.json$/D', $file, $match)
            || !isset($this->documents[$match[1]])) {
            return null;
        }
        $document = $this->documents[$match[1]];
        if ($match[2] === 'expect') {
            return json_encode($document['expectations'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
        }

        $arazzo = clone $document['arazzo'];
        foreach ($arazzo->sourceDescriptions ?? [] as $index => $source) {
            if (is_string($source->url ?? null) && Capabilities::isLocalUrl($source->url)) {
                $arazzo->sourceDescriptions[$index] = clone $source;
                $arazzo->sourceDescriptions[$index]->url = Capabilities::withBase($pathBase, $source->url);
            }
        }

        return json_encode($arazzo, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
    }

    private static function read(string $path): \stdClass
    {
        $file = basename($path);
        $contents = is_file($path) ? @file_get_contents($path) : false;
        if ($contents === false) {
            throw new \InvalidArgumentException("Cannot read journey document {$file}.");
        }
        try {
            $document = json_decode($contents, false, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $error) {
            throw new \InvalidArgumentException("Invalid JSON in journey document {$file}.", 0, $error);
        }
        if (!$document instanceof \stdClass) {
            throw new \InvalidArgumentException("Expected a JSON object in journey document {$file}.");
        }

        return $document;
    }
}
