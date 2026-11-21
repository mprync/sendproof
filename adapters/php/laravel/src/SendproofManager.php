<?php

declare(strict_types=1);

namespace Sendproof\Laravel;

use Closure;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Http\Request;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Contracts\PreviewProvider;
use Sendproof\Core\Trace\FileTraceStore;
use Sendproof\Core\Trace\TraceOwner;
use Sendproof\Core\Trace\TraceStore;
use Sendproof\Core\Ui\UiBundle;
use Sendproof\Laravel\Eloquent\EloquentPreviewProvider;

/**
 * Application-level services for Sendproof: opt-in, identity, authorization, provider and effects.
 *
 * Effect recording is forwarded to the request's recorder, so `Sendproof::tryRecordEmail(...)`
 * works from any handler.
 */
final class SendproofManager
{
    private ?Closure $identity = null;
    private ?Closure $authorizer = null;
    private ?PreviewProvider $provider = null;
    private bool $providerResolved = false;
    private ?TraceStore $store = null;

    public function __construct(private readonly Application $app)
    {
    }

    /** True only when explicitly enabled and the environment is allow-listed. */
    public function enabled(): bool
    {
        return (bool) $this->config('enabled', false)
            && in_array($this->app->environment(), (array) $this->config('environments', []), true);
    }

    /** Overrides how the signed-in user is shown: `fn (Request $request, ?Authenticatable $user): ?array{name:?string,role?:string}`. */
    public function identifyUsing(Closure $resolver): void
    {
        $this->identity = $resolver;
    }

    /** Overrides the workbench authorization check: `fn (Request $request): bool`. */
    public function authorizeUsing(Closure $authorizer): void
    {
        $this->authorizer = $authorizer;
    }

    /** @return array{name:?string,role?:?string}|null */
    public function identity(Request $request): ?array
    {
        $user = $this->user();
        if ($this->identity !== null) {
            return ($this->identity)($request, $user);
        }

        return $user === null ? null : [
            'name' => $this->attribute($user, 'name') ?? $this->attribute($user, 'email'),
            'role' => $this->attribute($user, 'role'),
        ];
    }

    /** Key that scopes traces to the authenticated subject, or null when there is no stable subject. */
    public function ownerKey(Request $request): ?string
    {
        $user = $this->user();
        $subject = $user?->getAuthIdentifier();

        return TraceOwner::key($this->guardName(), $subject === null ? null : (string) $subject, $request->getBaseUrl());
    }

    /** Whether the current user may use the workbench. */
    public function authorized(Request $request): bool
    {
        if ($this->authorizer !== null) {
            return (bool) ($this->authorizer)($request);
        }
        $ability = $this->config('authorize');

        return $ability === null || $this->app->make('Illuminate\Contracts\Auth\Access\Gate')->allows($ability);
    }

    public function provider(): ?PreviewProvider
    {
        if (!$this->providerResolved) {
            $this->providerResolved = true;
            $configured = $this->config('provider', 'eloquent');
            $this->provider = match (true) {
                $configured === null || $configured === false => null,
                $configured === 'eloquent' => $this->app->make(EloquentPreviewProvider::class),
                default => $this->app->make($configured),
            };
        }

        return $this->provider;
    }

    public function traces(): TraceStore
    {
        return $this->store ??= new FileTraceStore(
            $this->config('trace.path') ?? $this->app->storagePath('framework/sendproof-traces'),
            max(1, (int) $this->config('trace.ttl', 300)),
            (int) $this->config('trace.per_owner', 8),
            (int) $this->config('trace.total', 32),
        );
    }

    public function ui(): UiBundle
    {
        return ($path = $this->config('ui_path')) === null ? UiBundle::embedded() : new UiBundle($path);
    }

    public function recorder(): Recorder
    {
        return $this->app->make(Recorder::class);
    }

    /** @param array<int,mixed> $arguments */
    public function __call(string $method, array $arguments): mixed
    {
        return match ($method) {
            'isPreview' => $this->recorder()->isPreview(),
            default => $this->recorder()->{$method}(...$arguments),
        };
    }

    public function config(string $key, mixed $default = null): mixed
    {
        return $this->app->make('config')->get('sendproof.' . $key, $default);
    }

    public function guardName(): string
    {
        return $this->config('guard') ?? $this->app->make('auth')->getDefaultDriver();
    }

    private function user(): ?Authenticatable
    {
        return $this->app->make('auth')->guard($this->config('guard'))->user();
    }

    private function attribute(Authenticatable $user, string $name): ?string
    {
        $value = data_get($user, $name);

        return is_scalar($value) ? (string) $value : null;
    }
}
