<?php

declare(strict_types=1);

namespace Fixture\Controller;

use Fixture\Security\Personas;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

/** Password sign-in and persona switching. Persona routes are admin-only through access control. */
final class AuthController
{
    #[Route('/auth/sign-in', methods: ['POST'])]
    public function signIn(Request $request): Response
    {
        $data = json_decode($request->getContent(), true);
        $email = is_array($data) && is_string($data['email'] ?? null) ? $data['email'] : '';
        $password = is_array($data) && is_string($data['password'] ?? null) ? $data['password'] : '';
        if (!isset(Personas::ALL[$email]) || !hash_equals(Personas::PASSWORD, $password)) {
            return new JsonResponse(['title' => 'Invalid credentials'], 401);
        }

        return $this->session($email);
    }

    #[Route('/auth/personas', methods: ['GET'])]
    public function personas(): Response
    {
        return new JsonResponse(array_values(Personas::ALL));
    }

    #[Route('/auth/personas/{email}', methods: ['POST'])]
    public function switch(string $email): Response
    {
        return isset(Personas::ALL[$email]) ? $this->session($email) : new JsonResponse(['title' => 'Not found'], 404);
    }

    private function session(string $email): Response
    {
        $response = new JsonResponse(Personas::ALL[$email]);
        $response->headers->setCookie(Personas::cookie($email));

        return $response;
    }
}
