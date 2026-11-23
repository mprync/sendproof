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
use OpenSearch\Client as OpenSearchClient;
use OpenSearch\GuzzleClientFactory;
use Sendproof\Laravel\Facades\Sendproof;

/** Signed-cookie authentication plus the scenario switches of the conformance fixture. */
final class FixtureServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $scenario = getenv('BENCH_SCENARIO') ?: 'standard';
        $this->registerStores();
        $this->app->booting(function () use ($scenario): void {
            // The compose SQL Server uses a self-signed certificate, and Laravel's sqlsrv config leaves these unset.
            if (getenv('DB_CONNECTION') === 'sqlsrv') {
                config(['database.connections.sqlsrv.encrypt' => 'no', 'database.connections.sqlsrv.trust_server_certificate' => 'true']);
            }
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
        if (($url = getenv('BENCH_OPENSEARCH_URL')) !== false && $url !== '') {
            // The PSR-18 transport of opensearch-php 2 (the Symfony fixture uses the legacy ClientBuilder).
            $this->app->singleton(OpenSearchClient::class, fn () => (new GuzzleClientFactory())->create(['base_uri' => $url]));
        }
    }

    public function boot(): void
    {
        $journeys = dirname(__DIR__, 3) . '/journeys/';
        $openApi = require $journeys . 'openapi.php';
        Sendproof::addJourneys(require $journeys . 'conformance.php', $openApi(in_array(config('database.default'), ['mysql', 'mariadb'], true)));

        Auth::viaRequest('fixture', function (Request $request): ?GenericUser {
            $persona = Personas::fromCookie((string) $request->cookies->get(Personas::COOKIE));

            return $persona === null ? null : new GenericUser(['id' => $persona['email'], ...$persona]);
        });
    }
}
