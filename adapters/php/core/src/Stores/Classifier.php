<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores;

/**
 * Write classification for the batch-one data stores, driven by the shared tables in
 * spec/data-stores/ (embedded in {@see Tables}). Each table lists reads and connection-level
 * commands; everything else, including a command the table has never heard of, is a write, so the
 * guard fails closed when a store adds a command.
 *
 * Every method is pure. The shared vectors in spec/data-stores/classification-cases.json run
 * through them in core/tests/StoreClassifierTest.php.
 */
final class Classifier
{
    /** @var array<string,array<string,true>>|null */
    private static ?array $redis = null;
    /** @var array<string,mixed>|null */
    private static ?array $mongo = null;
    /** @var array<string,mixed>|null */
    private static ?array $dynamo = null;

    /**
     * Classifies a Redis command. `$name` is the command name in any case and `$args` its arguments,
     * of which only the first is read, to form `CONTAINER|SUBCOMMAND` keys such as `OBJECT|ENCODING`.
     * `$treatAsRead` holds host-declared reads, compared exactly against the upper-case key.
     *
     * @param list<mixed> $args
     * @param array<string,true>|null $treatAsRead see {@see Guard::readSet()}
     */
    public static function redis(string $name, array $args = [], ?array $treatAsRead = null): CommandKind
    {
        $tables = self::$redis ??= self::loadRedis();
        $command = strtoupper($name);
        $keys = [$command];
        if ($args !== [] && (is_string($args[0]) || is_int($args[0]) || $args[0] instanceof \Stringable)) {
            array_unshift($keys, $command . '|' . strtoupper((string) $args[0]));
        }
        foreach ($keys as $key) {
            if (isset($tables['session'][$key])) {
                return CommandKind::Session;
            }
            if (isset($tables['transaction'][$key])) {
                return CommandKind::Transaction;
            }
            if (isset($tables['read'][$key]) || isset($treatAsRead[$key])) {
                return CommandKind::Read;
            }
        }

        return CommandKind::Write;
    }

    /**
     * Classifies a MongoDB command document by its first key, case-insensitively. `aggregate` is a
     * write when any stage at any depth (sub-pipelines included) is `$out` or `$merge`; `explain`
     * takes the classification of the command inside it. `refusedInTransaction` names what a
     * `preview`-mode Preview must block first, such as `$out` or `count`.
     * `$treatAsRead` holds host-declared reads in lower case.
     *
     * @param array<string,mixed>|object $command
     * @param array<string,true>|null $treatAsRead
     * @return array{kind:CommandKind,refusedInTransaction:?string}
     */
    public static function mongo(array|object $command, ?array $treatAsRead = null): array
    {
        $tables = self::$mongo ??= self::loadMongo();
        $document = self::asArray($command) ?? [];
        $name = (string) (array_key_first($document) ?? '');
        $lower = strtolower($name);
        if ($lower === 'explain' && ($inner = self::asArray($document[$name])) !== null) {
            return self::mongo($inner, $treatAsRead);
        }

        $refused = isset($tables['notInTransaction'][$lower]) ? $name : null;
        $pipeline = $lower === 'aggregate' ? ($document['pipeline'] ?? null) : null;
        if ($lower === 'aggregate') {
            foreach ($tables['stages'] as $stage) {
                if (self::pipelineUses($pipeline, [$stage => true])) {
                    $refused = $stage;
                    break;
                }
            }
        }
        $result = static fn (CommandKind $kind): array => ['kind' => $kind, 'refusedInTransaction' => $refused];

        if (isset($tables['session'][$lower])) {
            return ['kind' => CommandKind::Session, 'refusedInTransaction' => null];
        }
        if ($lower === 'aggregate' && self::pipelineUses($pipeline, ['$out' => true, '$merge' => true])) {
            return $result(CommandKind::Write);
        }
        if (isset($tables['read'][$lower]) || isset($treatAsRead[$lower])) {
            return $result(CommandKind::Read);
        }

        return $result(CommandKind::Write);
    }

    /**
     * Skips whitespace and SQL-style comments, then returns the first word of a PartiQL statement
     * in upper case. An unterminated block comment yields an empty string, which is not `SELECT`.
     */
    public static function partiqlVerb(mixed $statement): string
    {
        $text = is_scalar($statement) || $statement instanceof \Stringable ? (string) $statement : '';
        while (true) {
            $trimmed = ltrim($text);
            if (str_starts_with($trimmed, '--')) {
                $end = strpos($trimmed, "\n");
                $text = $end === false ? '' : substr($trimmed, $end + 1);
                continue;
            }
            if (str_starts_with($trimmed, '/*')) {
                $end = strpos($trimmed, '*/');
                if ($end === false) {
                    return '';
                }
                $text = substr($trimmed, $end + 2);
                continue;
            }

            return preg_match('/^[A-Za-z]+/', $trimmed, $match) === 1 ? strtoupper($match[0]) : '';
        }
    }

    /**
     * Classifies a DynamoDB action and its input as read or write. A PartiQL request is a read only
     * when every statement in it is a `SELECT`. `$treatAsRead` holds host-declared action names.
     *
     * @param array<string,mixed> $input
     * @param array<string,true>|null $treatAsRead
     */
    public static function dynamo(string $operation, array $input = [], ?array $treatAsRead = null): CommandKind
    {
        $tables = self::$dynamo ??= self::loadDynamo();
        if (isset($tables['read'][$operation]) || isset($treatAsRead[$operation])) {
            return CommandKind::Read;
        }
        if (isset($tables['partiql'][$operation])) {
            $statements = [];
            if ($operation === 'ExecuteStatement') {
                $statements = [$input['Statement'] ?? null];
            } else {
                $list = $input['Statements'] ?? $input['TransactStatements'] ?? null;
                foreach (is_array($list) ? $list : [] as $item) {
                    $statements[] = is_array($item) ? ($item['Statement'] ?? null) : null;
                }
            }
            foreach ($statements as $statement) {
                if (self::partiqlVerb($statement) !== 'SELECT') {
                    return CommandKind::Write;
                }
            }

            return $statements === [] ? CommandKind::Write : CommandKind::Read;
        }

        return CommandKind::Write;
    }

    /**
     * Converts a command document or BSON value to a plain array, or null for a scalar BSON type
     * such as an ObjectId, which has no keys to search.
     *
     * @return array<int|string,mixed>|null
     */
    public static function asArray(mixed $value): ?array
    {
        return match (true) {
            is_array($value) => $value,
            $value instanceof \ArrayObject => $value->getArrayCopy(),
            $value instanceof \stdClass => (array) $value,
            // The driver's own document and array types, and anything serialisable to BSON.
            $value instanceof \MongoDB\BSON\Document, $value instanceof \MongoDB\BSON\PackedArray
                => $value->toPHP(['root' => 'array', 'document' => 'array', 'array' => 'array']),
            $value instanceof \MongoDB\BSON\Serializable => self::asArray($value->bsonSerialize()),
            default => null,
        };
    }

    /**
     * Whether any key of an aggregation pipeline, at any depth (sub-pipelines included), is in `$stages`.
     *
     * @param array<string,true> $stages
     */
    private static function pipelineUses(mixed $value, array $stages): bool
    {
        $items = self::asArray($value);
        if ($items === null) {
            return false;
        }
        foreach ($items as $key => $inner) {
            if (is_string($key) && isset($stages[$key])) {
                return true;
            }
            if (self::pipelineUses($inner, $stages)) {
                return true;
            }
        }

        return false;
    }

    /** @return array<string,array<string,true>> */
    private static function loadRedis(): array
    {
        $table = Tables::redis();

        return [
            'read' => self::set([...$table['read'], ...$table['moduleRead']]),
            'session' => self::set($table['session']),
            'transaction' => self::set($table['transaction']),
        ];
    }

    /** @return array<string,mixed> */
    private static function loadMongo(): array
    {
        $table = Tables::mongodb();

        return [
            'read' => self::set($table['read'], true),
            'session' => self::set($table['session'], true),
            'notInTransaction' => self::set($table['notInTransaction']['commands'], true),
            'stages' => $table['notInTransaction']['stages'],
        ];
    }

    /** @return array<string,mixed> */
    private static function loadDynamo(): array
    {
        $table = Tables::dynamodb();

        return ['read' => self::set($table['read']), 'partiql' => self::set($table['partiql']['operations'])];
    }

    /**
     * @param list<string> $names
     * @return array<string,true>
     */
    private static function set(array $names, bool $lower = false): array
    {
        $set = [];
        foreach ($names as $name) {
            $set[$lower ? strtolower($name) : $name] = true;
        }

        return $set;
    }
}
