<?php

declare(strict_types=1);

use Sendproof\Core\Journeys\JourneyDocument;
use Sendproof\Core\Journeys\Ref;

$document = new JourneyDocument('conformance', 'Conformance journeys', 'sendproofConformance');
$document->journey('itemLookup')
    ->name('Look up an item')
    ->definedIn('itemLookup', 'journeys/conformance.php')
    ->input('id', ['type' => 'string', 'default' => 'conformance-item'])
    ->step('getItem', 'readItem')
    ->set('id', Ref::input('id'))
    ->succeedsWith(200);

return $document;
