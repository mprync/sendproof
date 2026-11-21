<?php

declare(strict_types=1);

namespace Fixture\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Anonymous API callers receive 401. */
final class RequireUser
{
    public function handle(Request $request, Closure $next): Response
    {
        return $request->user() === null ? response()->json(['title' => 'Unauthenticated'], 401) : $next($request);
    }
}
