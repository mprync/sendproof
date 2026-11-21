<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests\Support;

use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Preview\CapturedResponse;
use Sendproof\Core\Preview\NoSqlProvider;
use Sendproof\Core\Preview\PreviewResult;
use Sendproof\Core\Preview\PreviewRunner;
use Sendproof\Core\Preview\PreviewState;
use Sendproof\Core\Stores\DataStore;

/** Runs a handler through the real Preview pipeline against hooked stores, with no SQL database. */
trait RunsPreviews
{
    /** @param list<DataStore> $stores */
    private function preview(Recorder $recorder, array $stores, \Closure $handler): PreviewResult
    {
        $state = new PreviewState(hrtime(true));

        return (new PreviewRunner($recorder))->run(new NoSqlProvider(), $state, static function () use ($handler, $state): CapturedResponse {
            $state->reached = true;
            $response = $handler();
            $state->completed = true;

            return $response instanceof CapturedResponse ? $response : new CapturedResponse(200, ['Content-Type' => 'application/json'], '{"ok":true}');
        }, null, $stores);
    }
}
