<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\TestCase;
use Sendproof\Core\Ui\UiBundle;

final class UiBundleTest extends TestCase
{
    private string $directory;

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . '/sendproof-ui-' . bin2hex(random_bytes(4));
        mkdir($this->directory);
        file_put_contents($this->directory . '/index.html', '<title>Sendproof</title>');
        file_put_contents($this->directory . '/app.js', 'export {}');
        file_put_contents($this->directory . '/stray.js', 'not listed');
        $files = [];
        foreach (['index.html' => 'text/html; charset=utf-8', 'app.js' => 'text/javascript; charset=utf-8'] as $name => $type) {
            $files[$name] = ['sha256' => hash_file('sha256', "{$this->directory}/{$name}"), 'bytes' => filesize("{$this->directory}/{$name}"), 'contentType' => $type];
        }
        file_put_contents($this->directory . '/manifest.json', json_encode(['version' => '1', 'bundleHash' => 'abc', 'files' => $files]));
    }

    protected function tearDown(): void
    {
        array_map('unlink', glob($this->directory . '/*') ?: []);
        rmdir($this->directory);
    }

    public function testServesOnlyManifestFilesWithTheirContentType(): void
    {
        $bundle = new UiBundle($this->directory);

        $this->assertTrue($bundle->isAvailable());
        $this->assertSame('text/html; charset=utf-8', $bundle->asset('')->contentType);
        $this->assertSame('text/javascript; charset=utf-8', $bundle->asset('app.js')->contentType);
        $this->assertNull($bundle->asset('stray.js'));
        $this->assertNull($bundle->asset('../manifest.json'));
    }

    public function testATamperedFileFailsClosed(): void
    {
        file_put_contents($this->directory . '/app.js', 'alert(1)');

        $this->assertNull((new UiBundle($this->directory))->asset('app.js'));
    }

    public function testMissingBundleIsUnavailable(): void
    {
        $this->assertFalse((new UiBundle($this->directory . '/missing'))->isAvailable());
    }

    public function testEmbeddedBundleLocationIsInsideThePackage(): void
    {
        $this->assertInstanceOf(UiBundle::class, UiBundle::embedded());
    }
}
