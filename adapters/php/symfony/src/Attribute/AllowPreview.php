<?php

declare(strict_types=1);

namespace Sendproof\Symfony\Attribute;

/**
 * Opts a controller action (or every action of a controller) in to Preview and Observed Send.
 *
 * The action must be safe to run in a rollback-only transaction: every write goes through a
 * Doctrine connection listed in `sendproof.connections`, and every external effect asks
 * `Recorder::tryRecordEffect()` (or the typed variants) before it is delivered.
 *
 * A route may also opt in with the default `_sendproof_preview: true`.
 */
#[\Attribute(\Attribute::TARGET_METHOD | \Attribute::TARGET_CLASS)]
final class AllowPreview
{
}
