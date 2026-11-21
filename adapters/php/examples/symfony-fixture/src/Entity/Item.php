<?php

declare(strict_types=1);

namespace Fixture\Entity;

use Doctrine\ORM\Mapping as ORM;

/** An item with a string primary key. */
#[ORM\Entity]
#[ORM\Table(name: 'items')]
class Item
{
    public function __construct(
        #[ORM\Id]
        #[ORM\Column(type: 'string', length: 255)]
        public string $id,
        #[ORM\Column(type: 'string', length: 255)]
        public string $name,
    ) {
    }

    /** @return array{id:string,name:string} */
    public function toArray(): array
    {
        return ['id' => $this->id, 'name' => $this->name];
    }
}
