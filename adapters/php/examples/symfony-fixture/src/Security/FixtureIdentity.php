<?php

declare(strict_types=1);

namespace Fixture\Security;

use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Security\Core\User\UserInterface;
use Sendproof\Symfony\Identity\IdentityResolver;

/** Shows the persona's display name and role. */
final class FixtureIdentity implements IdentityResolver
{
    public function identify(Request $request, ?UserInterface $user): ?array
    {
        $persona = $user === null ? null : (Personas::ALL[$user->getUserIdentifier()] ?? null);

        return $persona === null ? null : ['name' => $persona['name'], 'role' => $persona['role']];
    }
}
