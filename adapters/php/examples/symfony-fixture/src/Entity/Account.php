<?php

declare(strict_types=1);

namespace Fixture\Entity;

use Doctrine\ORM\Mapping as ORM;

/** An account with a secret column, for the secret-columns shared rule. */
#[ORM\Entity]
#[ORM\Table(name: 'accounts')]
class Account
{
    public function __construct(
        #[ORM\Id]
        #[ORM\Column(type: 'string', length: 255)]
        public string $id,
        #[ORM\Column(type: 'string', length: 255)]
        public string $email,
        #[ORM\Column(name: 'password_hash', type: 'string', length: 255)]
        public string $passwordHash,
    ) {
    }
}
