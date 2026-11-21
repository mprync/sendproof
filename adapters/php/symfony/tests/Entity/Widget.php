<?php

declare(strict_types=1);

namespace Sendproof\Symfony\Tests\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'widgets')]
class Widget
{
    public function __construct(
        #[ORM\Id]
        #[ORM\Column(type: 'string', length: 64)]
        public string $id,
        #[ORM\Column(type: 'string', length: 255)]
        public string $name,
        #[ORM\Column(name: 'api_token', type: 'string', length: 255, nullable: true)]
        public ?string $apiToken = null,
    ) {
    }
}
