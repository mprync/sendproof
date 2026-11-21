<?php

declare(strict_types=1);

namespace Fixture\Providers;

use Fixture\Support\FailingRollbackProvider;
use Fixture\Support\Personas;
use Illuminate\Auth\GenericUser;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\ServiceProvider;

/** Signed-cookie authentication plus the scenario switches of the conformance fixture. */
final class FixtureServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $scenario = getenv('BENCH_SCENARIO') ?: 'standard';
        $this->app->booting(function () use ($scenario): void {
            if ($scenario === 'no-provider') {
                config(['sendproof.provider' => null]);
            } elseif ($scenario === 'rollback-failure') {
                config(['sendproof.provider' => FailingRollbackProvider::class]);
            }
        });
    }

    public function boot(): void
    {
        Auth::viaRequest('fixture', function (Request $request): ?GenericUser {
            $persona = Personas::fromCookie((string) $request->cookies->get(Personas::COOKIE));

            return $persona === null ? null : new GenericUser(['id' => $persona['email'], ...$persona]);
        });
    }
}
