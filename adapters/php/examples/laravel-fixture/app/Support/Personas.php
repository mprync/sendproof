<?php

declare(strict_types=1);

namespace Fixture\Support;

use Symfony\Component\HttpFoundation\Cookie;

/** The fixture's two accounts and their HMAC-signed session cookie. */
final class Personas
{
    public const COOKIE = 'fixture_session';
    public const PASSWORD = 'bench-fixture';
    public const ALL = [
        'admin@example.test' => ['email' => 'admin@example.test', 'name' => 'Fixture Admin', 'role' => 'admin'],
        'viewer@example.test' => ['email' => 'viewer@example.test', 'name' => 'Fixture Viewer', 'role' => 'viewer'],
    ];

    /** @return array{email:string,name:string,role:string}|null */
    public static function fromCookie(string $value): ?array
    {
        [$email, $signature] = array_pad(explode('.', $value, 2), 2, '');
        $email = base64_decode(strtr($email, '-_', '+/'), true);

        return $email !== false && hash_equals(self::sign($email), $signature) ? (self::ALL[$email] ?? null) : null;
    }

    public static function cookie(string $email): Cookie
    {
        $value = rtrim(strtr(base64_encode($email), '+/', '-_'), '=') . '.' . self::sign($email);

        return new Cookie(self::COOKIE, $value, 0, '/', null, false, true, false, Cookie::SAMESITE_LAX);
    }

    private static function sign(string $email): string
    {
        return hash_hmac('sha256', $email, (string) config('app.key'));
    }
}
