<?php

declare(strict_types=1);

namespace TestBench\Symfony;

use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Security\Core\Authentication\Token\Storage\TokenStorageInterface;
use Symfony\Component\Security\Core\Authorization\AuthorizationCheckerInterface;
use Symfony\Component\Security\Core\User\UserInterface;
use TestBench\Core\Capture\Recorder;
use TestBench\Core\Contracts\PreviewProvider;
use TestBench\Core\Trace\FileTraceStore;
use TestBench\Core\Trace\TraceOwner;
use TestBench\Core\Trace\TraceStore;
use TestBench\Core\Ui\UiBundle;
use TestBench\Symfony\Identity\IdentityResolver;

/**
 * Application-level services for Test Bench: opt-in, identity, authorization, provider and storage.
 */
final class TestBenchManager
{
    private ?TraceStore $store = null;

    /**
     * @param array<string,mixed> $settings The processed `testbench` configuration
     */
    public function __construct(
        private readonly array $settings,
        private readonly string $environment,
        private readonly string $projectDir,
        private readonly Recorder $recorder,
        private readonly IdentityResolver $identity,
        private readonly ?PreviewProvider $provider = null,
        private readonly ?TokenStorageInterface $tokens = null,
        private readonly ?AuthorizationCheckerInterface $authorization = null,
    ) {
    }

    /** True only when explicitly enabled and the kernel environment is allow-listed. */
    public function enabled(): bool
    {
        return $this->settings['enabled'] === true && in_array($this->environment, $this->settings['environments'], true);
    }

    public function setting(string $name): mixed
    {
        return $this->settings[$name] ?? null;
    }

    public function environment(): string
    {
        return $this->environment;
    }

    public function provider(): ?PreviewProvider
    {
        return $this->provider;
    }

    public function recorder(): Recorder
    {
        return $this->recorder;
    }

    /** @return array{name:?string,role?:?string}|null */
    public function identity(Request $request): ?array
    {
        return $this->identity->identify($request, $this->user());
    }

    /** Key that scopes traces to the authenticated subject, or null when there is no stable subject. */
    public function ownerKey(Request $request): ?string
    {
        $token = $this->tokens?->getToken();
        $user = $token?->getUser();

        if (!$user instanceof UserInterface) {
            return null;
        }
        // The firewall separates user namespaces: "alice" on an admin firewall is not "alice" on the API one.
        $firewall = method_exists($token, 'getFirewallName') ? (string) $token->getFirewallName() : '';

        return TraceOwner::key($token::class . '#' . $firewall, $user->getUserIdentifier(), $request->getBaseUrl());
    }

    /** Whether the current user may use the workbench. */
    public function authorized(): bool
    {
        $attribute = $this->settings['authorize'] ?? null;

        return $attribute === null || ($this->authorization?->isGranted($attribute) ?? false);
    }

    public function traces(): TraceStore
    {
        $trace = $this->settings['trace'];

        return $this->store ??= new FileTraceStore(
            $trace['path'] ?? $this->projectDir . '/var/testbench-traces',
            $trace['ttl'],
            $trace['per_owner'],
            $trace['total'],
        );
    }

    public function ui(): UiBundle
    {
        $path = $this->settings['ui_path'] ?? null;

        return $path === null ? UiBundle::embedded() : new UiBundle($path);
    }

    /** Whether SQL parameter values may be shown, defaulting to dev and test only. */
    public function showSqlValues(): bool
    {
        return $this->settings['include_sql_parameter_values'] ?? in_array($this->environment, ['dev', 'test'], true);
    }

    private function user(): ?UserInterface
    {
        $user = $this->tokens?->getToken()?->getUser();

        return $user instanceof UserInterface ? $user : null;
    }
}
