<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\MongoDb;

use MongoDB\BSON\Timestamp;
use MongoDB\Driver\Session;

/**
 * The state of one `preview`-mode Preview on one MongoDB client: its session and transaction, the
 * change candidates seen so far and the deadline.
 *
 * @internal
 */
final class MongoPreview
{
    /** Set once a command carried the session to the server. */
    public bool $used = false;
    /** Set once the transaction was aborted and the session ended. */
    public bool $finished = false;
    /**
     * The transaction's snapshot time: the `operationTime` of the first reply to a command the
     * Preview session sent. `before` images are read at this time, so a concurrent commit by
     * another request never shows up as a Preview change.
     */
    public ?Timestamp $startTime = null;
    /** @var array<string,array{namespace:string,collection:string,id:mixed,via:?string}> Documents the Preview may have changed */
    public array $candidates = [];
    /** @var list<array{namespace:string,collection:string,filter:mixed,via:?string}> Filters whose matches, before and inside the transaction, are candidates */
    public array $filters = [];
    /** @var \WeakMap<Session,bool> Sessions the handler created through the guarded client, and whether a command was moved off each; those commands join this transaction */
    public \WeakMap $shells;

    /**
     * @param string $lsid Lower-case hex of the session's logical session id
     * @param int $deadlineNs The `hrtime` after which the Preview may no longer use its transaction
     */
    public function __construct(public readonly Session $session, public readonly string $lsid, public readonly int $deadlineNs)
    {
        $this->shells = new \WeakMap();
    }
}
