<?php

declare(strict_types=1);

namespace TestBench\Laravel\Http;

use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use TestBench\Laravel\TestBenchManager;

/**
 * Route middleware on every `/bench` route that applies the workbench authorization check.
 *
 * It honours both the `testbench.authorize` gate ability and a closure registered with
 * `TestBench::authorizeUsing()`, so the UI, discovery and traces are gated exactly like previews.
 */
final class AuthorizeWorkbench
{
    public function __construct(private readonly TestBenchManager $manager)
    {
    }

    public function handle(Request $request, Closure $next): Response
    {
        if ($this->manager->authorized($request)) {
            return $next($request);
        }
        $status = $this->manager->ownerKey($request) === null ? 401 : 403;

        return new JsonResponse(
            ['title' => $status === 401 ? 'Authentication is required for the workbench.' : 'The workbench is forbidden.', 'status' => $status],
            $status,
            ['Cache-Control' => 'no-store', 'Content-Type' => 'application/problem+json'],
        );
    }
}
