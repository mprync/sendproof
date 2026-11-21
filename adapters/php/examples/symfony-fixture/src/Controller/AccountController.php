<?php

declare(strict_types=1);

namespace Fixture\Controller;

use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Fixture\Entity\Account;
use Fixture\Entity\Item;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Sendproof\Symfony\Attribute\AllowPreview;

/** The shared security rules' routes (spec/conformance/fixture.md#shared-security-rules). */
final class AccountController
{
    public function __construct(private readonly EntityManagerInterface $em, private readonly Connection $connection)
    {
    }

    #[Route('/accounts', methods: ['POST'])]
    #[AllowPreview]
    public function create(Request $request): Response
    {
        $data = json_decode($request->getContent(), true);
        if (!is_array($data) || !is_string($data['id'] ?? null) || !is_string($data['email'] ?? null) || !is_string($data['password'] ?? null)) {
            return new JsonResponse(['title' => 'id, email and password are required'], 422);
        }
        $this->em->persist(new Account($data['id'], $data['email'], 'hashed:' . $data['password']));
        $this->em->flush();

        return new JsonResponse(['id' => $data['id'], 'email' => $data['email']], 201);
    }

    #[Route('/accounts/{id}', methods: ['GET'])]
    public function read(string $id): Response
    {
        $account = $this->em->find(Account::class, $id);

        return $account === null ? new JsonResponse(['title' => 'Not found'], 404) : new JsonResponse(['id' => $account->id, 'email' => $account->email]);
    }

    /** Inserts the item, then ends the transaction the handler does not own: Preview must refuse the COMMIT. */
    #[Route('/items/{id}/commit', methods: ['POST'])]
    #[AllowPreview]
    public function commit(Request $request, string $id): Response
    {
        $data = json_decode($request->getContent(), true);
        $name = is_array($data) && is_string($data['name'] ?? null) ? $data['name'] : 'Committed';
        $this->em->persist(new Item($id, $name));
        $this->em->flush();
        $this->connection->executeStatement('COMMIT');

        return new JsonResponse(['id' => $id, 'name' => $name], 201);
    }
}
