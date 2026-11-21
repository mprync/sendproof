<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

use Illuminate\Support\Facades\Route;

/**
 * A Laravel application with data stores hooked. Subclasses name the stores they need in
 * {@see stores()}, point the application at the compose services in {@see configure()}, and add
 * their routes in {@see storeRoutes()}. Each test is skipped, with the command to start the
 * service, when a service it needs does not answer.
 */
abstract class StoresTestCase extends TestCase
{
    /** @return list<string> The services this test class needs: `mongodb`, `redis`, `dynamodb` */
    abstract protected function stores(): array;

    /** Sets the application's own configuration for the stores. */
    abstract protected function configure($app): void;

    /** Adds the routes of this test class. */
    abstract protected function storeRoutes(): void;

    protected function defineEnvironment($app): void
    {
        foreach ($this->stores() as $store) {
            Services::need($store);
        }
        parent::defineEnvironment($app);
        $this->configure($app);
    }

    protected function defineRoutes($router): void
    {
        parent::defineRoutes($router);
        Route::middleware([RequireUser::class])->group(fn () => $this->storeRoutes());
    }

    /** @return array<string,mixed> */
    protected function capabilities(): array
    {
        return $this->getJson('/sendproof/_api/capabilities')->assertOk()->json();
    }

    /** The Db log entries of an envelope or trace for one store. */
    protected function dbEntries(array $document, string $system): array
    {
        return array_values(array_filter($document['logs'] ?? [], static fn (array $log): bool => $log['level'] === 'Db' && $log['db']['system'] === $system));
    }
}
