<?php

declare(strict_types=1);

namespace Fixture\Security;

use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;
use Symfony\Component\Security\Core\Exception\AuthenticationException;
use Symfony\Component\Security\Core\Exception\CustomUserMessageAuthenticationException;
use Symfony\Component\Security\Http\Authenticator\AbstractAuthenticator;
use Symfony\Component\Security\Http\Authenticator\Passport\Badge\UserBadge;
use Symfony\Component\Security\Http\Authenticator\Passport\Passport;
use Symfony\Component\Security\Http\Authenticator\Passport\SelfValidatingPassport;
use Symfony\Component\Security\Http\EntryPoint\AuthenticationEntryPointInterface;

/** Authenticates the signed fixture cookie. Anonymous API callers receive 401. */
final class CookieAuthenticator extends AbstractAuthenticator implements AuthenticationEntryPointInterface
{
    public function supports(Request $request): ?bool
    {
        return $request->cookies->has(Personas::COOKIE);
    }

    public function authenticate(Request $request): Passport
    {
        $email = Personas::emailFromCookie((string) $request->cookies->get(Personas::COOKIE));
        if ($email === null) {
            throw new CustomUserMessageAuthenticationException('Invalid session.');
        }

        return new SelfValidatingPassport(new UserBadge($email));
    }

    public function onAuthenticationSuccess(Request $request, TokenInterface $token, string $firewallName): ?Response
    {
        return null;
    }

    public function onAuthenticationFailure(Request $request, AuthenticationException $exception): ?Response
    {
        return new JsonResponse(['title' => 'Unauthenticated'], 401);
    }

    public function start(Request $request, ?AuthenticationException $authException = null): Response
    {
        return new JsonResponse(['title' => 'Unauthenticated'], 401);
    }
}
