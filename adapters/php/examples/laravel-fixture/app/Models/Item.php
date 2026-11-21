<?php

declare(strict_types=1);

namespace Fixture\Models;

use Illuminate\Database\Eloquent\Model;

/** An item with a string primary key. */
final class Item extends Model
{
    public $incrementing = false;
    public $timestamps = false;
    protected $keyType = 'string';
    protected $fillable = ['id', 'name'];
}
