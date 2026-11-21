<?php

declare(strict_types=1);

namespace Fixture\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Only the admin role may write. Viewers receive 403. */
final class RequireAdmin
{
    public function handle(Request $request, Closure $next): Response
    {
        return $request->user()?->role === 'admin' ? $next($request) : response()->json(['title' => 'Forbidden'], 403);
    }
}
