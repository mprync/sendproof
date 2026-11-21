<?php

declare(strict_types=1);

namespace Fixture\Controller;

use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Fixture\Entity\Item;
use Psr\Log\LoggerInterface;
use Symfony\Component\HttpFoundation\Cookie;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\ConflictHttpException;
use Symfony\Component\Routing\Attribute\Route;
use TestBench\Core\Capture\Recorder;
use TestBench\Symfony\Attribute\AllowPreview;

/** The items API the conformance runner exercises. Authorization lives in security access control. */
final class ItemController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly Connection $connection,
        private readonly Recorder $recorder,
        private readonly LoggerInterface $logger,
    ) {
    }

    #[Route('/items/{id}', methods: ['GET'])]
    public function read(string $id): Response
    {
        $item = $this->em->find(Item::class, $id);

        return $item === null ? new JsonResponse(['title' => 'Not found'], 404) : new JsonResponse($item->toArray());
    }

    #[Route('/items', methods: ['POST'])]
    #[AllowPreview]
    public function create(Request $request): Response
    {
        $data = json_decode($request->getContent(), true);
        if (!is_array($data) || !is_string($data['id'] ?? null) || $data['id'] === '' || !is_string($data['name'] ?? null) || $data['name'] === '') {
            return new JsonResponse(['title' => 'id and name are required'], 422);
        }
        $item = $this->insert($data['id'], $data['name']);
        $this->em->flush();

        $suppressed = $this->recorder->tryRecordEmail('Created item', 'bench@example.test', ['owner@example.test'], [], 'Item ' . $item->id, 'An item was created.');
        if (!$suppressed) {
            // A real application would deliver the email here.
        }
        $this->logger->info('created:' . $item->id);
        // A prepared statement keeps the parameter name. `executeQuery($sql, ['name' => ...])` would
        // reach the driver as a positional `?`, so only the statement text could be inspected.
        $statement = $this->connection->prepare('select :fixture_secret as value');
        $statement->bindValue('fixture_secret', 'fixture-secret-value');
        $statement->executeQuery()->fetchAllAssociative();

        return new JsonResponse($item->toArray(), 201);
    }

    #[Route('/items/{id}', methods: ['PATCH'])]
    #[AllowPreview]
    public function rename(Request $request, string $id): Response
    {
        $data = json_decode($request->getContent(), true);
        if (!is_array($data) || !is_string($data['name'] ?? null) || $data['name'] === '') {
            return new JsonResponse(['title' => 'name is required'], 422);
        }
        $item = $this->em->find(Item::class, $id);
        if ($item === null) {
            return new JsonResponse(['title' => 'Not found'], 404);
        }
        $item->name = $data['name'];
        $this->em->flush();
        $response = new JsonResponse($item->toArray());
        if ($request->query->has('tag')) {
            $response->headers->set('X-Fixture-Tag', (string) $request->query->get('tag'));
        }

        return $response;
    }

    #[Route('/items/{id}', methods: ['DELETE'])]
    #[AllowPreview]
    public function delete(string $id): Response
    {
        $item = $this->em->find(Item::class, $id);
        if ($item === null) {
            return new JsonResponse(['title' => 'Not found'], 404);
        }
        $this->em->remove($item);
        $this->em->flush();

        return new Response('', 204);
    }

    #[Route('/items/{id}/fail', methods: ['POST'])]
    #[AllowPreview]
    public function fail(Request $request, string $id): Response
    {
        $this->insert($id, 'Inserted');
        $this->em->flush();
        if ($request->query->get('mode') === 'exception') {
            throw new \RuntimeException('Unhandled failure after insert.');
        }

        return new JsonResponse(['title' => 'Conflict'], 409);
    }

    #[Route('/items/{id}/large', methods: ['POST'])]
    #[AllowPreview]
    public function large(string $id): Response
    {
        $this->insert($id, 'Inserted');
        $this->em->flush();

        return new Response(str_repeat('x', 1024 * 1024 + 1024), 200, ['Content-Type' => 'text/plain']);
    }

    #[Route('/items/{id}/redirect', methods: ['POST'])]
    #[AllowPreview]
    public function redirect(Request $request, string $id): Response
    {
        $this->insert($id, 'Inserted');
        $this->em->flush();
        $response = new Response('', 302, ['Location' => $request->getBaseUrl() . '/items/' . $id]);
        $response->headers->setCookie(new Cookie('inner_cookie', 'must-not-leak'));

        return $response;
    }

    #[Route('/items/{id}/capture', methods: ['POST'])]
    #[AllowPreview]
    public function capture(string $id): Response
    {
        for ($i = 0; $i < 201; $i++) {
            $this->em->persist(new Item($id . '-' . $i, 'Bulk ' . $i));
        }
        $this->em->flush();
        for ($i = 0; $i < 101; $i++) {
            $this->recorder->tryRecordEffect('message', 'Bulk effect ' . $i, ['topic' => 'bulk', 'payload' => $i]);
        }
        for ($i = 0; $i < 501; $i++) {
            $this->logger->info('bulk log ' . $i);
        }

        return new JsonResponse(['id' => $id, 'name' => 'captured'], 201);
    }

    /** Send only: not opted in to preview. */
    #[Route('/items/{id}/ordinary', methods: ['POST'])]
    public function ordinary(string $id): Response
    {
        $item = $this->insert($id, 'Inserted');
        $this->em->flush();

        return new JsonResponse($item->toArray(), 201);
    }

    private function insert(string $id, string $name): Item
    {
        if ($this->em->find(Item::class, $id) !== null) {
            throw new ConflictHttpException('Item exists');
        }
        $item = new Item($id, $name);
        $this->em->persist($item);

        return $item;
    }
}
