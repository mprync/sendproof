<?php

declare(strict_types=1);

namespace TestBench\Symfony\Attribute;

/**
 * Opts a controller action (or every action of a controller) in to Preview and Observed Send.
 *
 * The action must be safe to run in a rollback-only transaction: every write goes through a
 * Doctrine connection listed in `testbench.connections`, and every external effect asks
 * `Recorder::tryRecordEffect()` (or the typed variants) before it is delivered.
 *
 * A route may also opt in with the default `_testbench_preview: true`.
 */
#[\Attribute(\Attribute::TARGET_METHOD | \Attribute::TARGET_CLASS)]
final class AllowPreview
{
}
