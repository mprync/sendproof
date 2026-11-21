# @test-bench/nestjs

Import the dynamic module into a NestJS 11 application using the Express HTTP adapter. The default OpenAPI path is `/api-json`, the JSON route from `SwaggerModule.setup('api', …)`. Set `openApiUrl` if your application exposes a different document.

```ts
import { Controller, Module, Post, UseGuards } from '@nestjs/common';
import { TestBenchModule, TestBenchPreview } from '@test-bench/nestjs';

@Controller('items')
class ItemsController {
  @Post()
  @UseGuards(EditorGuard)
  @TestBenchPreview('POST', '/items')
  create() { return createItem(); }
}

@Module({
  controllers: [ItemsController],
  imports: [TestBenchModule.forRoot({
    environment: 'development',
    previewProvider: database,
    resolveIdentity: ({ raw: request }) => sessionIdentity(request),
  })],
})
class AppModule {}
```

Provide the same global prefix to the module's `basePath` option if your application uses `app.setGlobalPrefix`. Keep that prefix out of the OpenAPI operation template passed to `@TestBenchPreview`.

Preview re-enters the Express and Nest request pipelines in-process. Guards, pipes and interceptors run on the selected controller action. Use a provider that covers all writes and await work before sending the response. Choose buffered controller responses and suppress external effects using [the core recorder](../core).

## Types

The package is written in strict TypeScript and ships its declarations. Type references to `express` need `@types/express` in your project. The module registers its providers with explicit `@Inject` tokens, so the module itself does not depend on `emitDecoratorMetadata`. Only the Express HTTP adapter is supported; the module throws on startup for Fastify. A `basePath` must be a literal prefix without a trailing slash, `.` or `..` segments.

## Development

Sources live in `src/` (`decorator.ts`, `options.ts`, `runtime.ts`, `interceptor.ts`, `module.ts`, re-exported from `index.ts`). Tests are in `../tests/nestjs.test.mts` and boot real Nest applications on an ephemeral loopback port. They cover 10 cases: operation discovery and route matching, decorator validation, native guards, JSON bodies and observed Send, application middleware, options and validation, Preview preconditions, global prefix with `basePath`, response limits, and failure handling.
