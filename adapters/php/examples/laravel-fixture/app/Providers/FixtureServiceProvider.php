<?php

declare(strict_types=1);

namespace Fixture\Providers;

use Aws\DynamoDb\DynamoDbClient;
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
        $this->registerStores();
        $this->app->booting(function () use ($scenario): void {
            if ($scenario === 'no-provider') {
                config(['sendproof.provider' => null]);
            } elseif ($scenario === 'rollback-failure') {
                config(['sendproof.provider' => FailingRollbackProvider::class]);
            }
        });
    }

    /** Connects the data stores the runner provisioned for this process; none when the variables are absent. */
    private function registerStores(): void
    {
        if (($url = getenv('BENCH_MONGODB_URL')) !== false && $url !== '') {
            $this->app->register(\MongoDB\Laravel\MongoDBServiceProvider::class);
            config(['database.connections.mongodb' => [
                'driver' => 'mongodb',
                'dsn' => $url,
                'database' => ltrim((string) parse_url($url, PHP_URL_PATH), '/'),
            ]]);
        }
        if (($url = getenv('BENCH_REDIS_URL')) !== false && $url !== '') {
            $parts = parse_url($url);
            config([
                'database.redis.client' => getenv('BENCH_PHP_REDIS_CLIENT') ?: 'predis',
                // The runner reads keys under BENCH_REDIS_PREFIX, so Laravel adds no prefix of its own.
                'database.redis.options.prefix' => '',
                'database.redis.default' => [
                    'host' => $parts['host'] ?? '127.0.0.1', 'port' => $parts['port'] ?? 6379,
                    'password' => isset($parts['pass']) ? rawurldecode($parts['pass']) : null, 'database' => 0,
                ],
            ]);
        }
        if (($url = getenv('BENCH_DYNAMODB_URL')) !== false && $url !== '') {
            $this->app->singleton(DynamoDbClient::class, fn () => new DynamoDbClient([
                'region' => getenv('AWS_REGION') ?: 'us-east-1', 'version' => 'latest', 'endpoint' => $url,
                'credentials' => ['key' => getenv('AWS_ACCESS_KEY_ID'), 'secret' => getenv('AWS_SECRET_ACCESS_KEY')],
            ]));
        }
    }

    public function boot(): void
    {
        Auth::viaRequest('fixture', function (Request $request): ?GenericUser {
            $persona = Personas::fromCookie((string) $request->cookies->get(Personas::COOKIE));

            return $persona === null ? null : new GenericUser(['id' => $persona['email'], ...$persona]);
        });
    }
}
