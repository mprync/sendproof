<?php

/** Fixture overrides. Everything else comes from the package defaults. */
return [
    'api_name' => 'Sendproof Conformance',
    'middleware' => [],
    'auth_providers' => [
        ['label' => 'Fixture password', 'kind' => 'cookie', 'url' => '/auth/sign-in'],
        ['label' => 'Fixture personas', 'kind' => 'personas', 'url' => '/auth/personas'],
    ],
];
