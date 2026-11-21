<?php

declare(strict_types=1);

namespace Sendproof\Symfony\Tests\Entity;

use Doctrine\ORM\Mapping as ORM;

/** An entity whose primary key is itself a secret. */
#[ORM\Entity]
#[ORM\Table(name: 'access_tokens')]
class AccessToken
{
    public function __construct(
        #[ORM\Id]
        #[ORM\Column(type: 'string', length: 64)]
        public string $token,
        #[ORM\Column(type: 'string', length: 255)]
        public string $label,
    ) {
    }
}
