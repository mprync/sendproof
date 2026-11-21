<?php

return [
    'defaults' => ['guard' => 'fixture', 'passwords' => 'users'],
    'guards' => ['fixture' => ['driver' => 'fixture', 'provider' => 'users']],
    'providers' => ['users' => ['driver' => 'eloquent', 'model' => Fixture\Models\Item::class]],
    'passwords' => [],
];
