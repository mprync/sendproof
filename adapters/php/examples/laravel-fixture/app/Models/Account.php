<?php

declare(strict_types=1);

namespace Fixture\Models;

use Illuminate\Database\Eloquent\Model;

/** An account with a secret column, for the secret-columns shared rule. */
final class Account extends Model
{
    public $incrementing = false;
    public $timestamps = false;
    protected $keyType = 'string';
    protected $fillable = ['id', 'email', 'password_hash'];
}
