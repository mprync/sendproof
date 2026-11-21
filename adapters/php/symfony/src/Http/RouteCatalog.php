<?php

declare(strict_types=1);

namespace Sendproof\Symfony\Http;

use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Exception\MethodNotAllowedException;
use Symfony\Component\Routing\Exception\ResourceNotFoundException;
use Symfony\Component\Routing\Route;
use Symfony\Component\Routing\RouterInterface;
use Sendproof\Symfony\Attribute\AllowPreview;

/** Finds the routes that opted in to Preview and matches rewritten requests against them. */
final class RouteCatalog
{
    /** @var array<string,bool> */
    private array $attributes = [];

    public function __construct(private readonly RouterInterface $router)
    {
    }

    /**
     * Matches a request with the application's real routes without dispatching it.
     *
     * @return array<string,mixed> Route parameters including `_route` and `_controller`
     * @throws ResourceNotFoundException
     * @throws MethodNotAllowedException
     */
    public function match(Request $request): array
    {
        // The router listener has not seen this request yet, so give the matcher its host and method.
        $this->router->getContext()->fromRequest($request);

        return $this->router->matchRequest($request);
    }

    /** @param array<string,mixed> $parameters Result of {@see match()} */
    public function isMarked(array $parameters): bool
    {
        $route = isset($parameters['_route']) ? $this->router->getRouteCollection()->get((string) $parameters['_route']) : null;

        return $route !== null && $this->marked($route);
    }

    /** @return list<array{method:string,path:string}> */
    public function operations(): array
    {
        $operations = [];
        foreach ($this->router->getRouteCollection() as $route) {
            if (!$this->marked($route)) {
                continue;
            }
            foreach ($route->getMethods() as $method) {
                if ($method !== 'HEAD') {
                    $operations[$method . ' ' . $route->getPath()] = ['method' => $method, 'path' => $route->getPath()];
                }
            }
        }
        uasort($operations, static fn (array $a, array $b): int => [$a['path'], $a['method']] <=> [$b['path'], $b['method']]);

        return array_values($operations);
    }

    private function marked(Route $route): bool
    {
        if ($route->getDefault('_sendproof_preview') === true) {
            return true;
        }
        $controller = $route->getDefault('_controller');

        return is_string($controller) && $this->hasAttribute($controller);
    }

    /** Whether `Class::method` (or an invokable class) carries {@see AllowPreview} on the method or class. */
    private function hasAttribute(string $controller): bool
    {
        return $this->attributes[$controller] ??= $this->reflect($controller);
    }

    private function reflect(string $controller): bool
    {
        [$class, $method] = array_pad(explode('::', $controller, 2), 2, '__invoke');
        if (!class_exists($class)) {
            return false;
        }
        $reflection = new \ReflectionClass($class);
        if ($reflection->getAttributes(AllowPreview::class) !== []) {
            return true;
        }

        return $reflection->hasMethod($method) && $reflection->getMethod($method)->getAttributes(AllowPreview::class) !== [];
    }
}
