import 'reflect-metadata';
import { Controller, Delete, ForbiddenException, Get, Module, Patch, Post,
  Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SendproofModule, SendproofPreview } from '@sendproof/nestjs';
import { authProviders, createFixture, fixtureJourneys, spec } from './fixture-service.mjs';
import { createStoreRoutes } from './fixture-stores.mjs';

const scenario = process.env.BENCH_SCENARIO ?? 'standard';
const basePath = process.env.BENCH_PATH_BASE ?? '';
const port = Number(process.env.PORT ?? 5355);
const fixture = createFixture(scenario);
const { session, previewProvider, ordinary } = fixture;
const storeRoutes = await createStoreRoutes({ operation: fixture.operation, reply: fixture.reply, insertItem: fixture.insert });
const operations = [...fixture.operations, ...storeRoutes.operations];

class FixturePolicy {
  canActivate(context) {
    const request = context.switchToHttp().getRequest();
    const identity = session(request.headers.cookie);
    if (!identity) throw new UnauthorizedException();
    if (request.method !== 'GET' && identity.role !== 'admin') throw new ForbiddenException();
    return true;
  }
}

class FixtureController {
  ready() { return 'ready'; }
  openApi() { return spec; }
}
Controller()(FixtureController);
Get('/ready')(FixtureController.prototype, 'ready', Object.getOwnPropertyDescriptor(FixtureController.prototype, 'ready'));
Get(['/api-json', '/openapi.json'])(FixtureController.prototype, 'openApi', Object.getOwnPropertyDescriptor(FixtureController.prototype, 'openApi'));

const verbs = { DELETE: Delete, GET: Get, PATCH: Patch, POST: Post };
for (const [index, operation] of [...operations, ...storeRoutes.unavailable, ...ordinary].entries()) {
  const { method, path, handler } = operation;
  const name = 'operation' + index;
  Object.defineProperty(FixtureController.prototype, name, {
    async value(req, res) {
      const response = await handler({
        base: basePath, params: req.params, body: req.body,
        query: new URLSearchParams(req.url.split('?')[1] ?? ''),
        identity: session(req.headers.cookie),
      });
      res.status(response.status).set(response.headers);
      if (response.body === null) return res.end();
      if (typeof response.body === 'string') return res.send(response.body);
      return res.json(response.body);
    },
  });
  const descriptor = Object.getOwnPropertyDescriptor(FixtureController.prototype, name);
  const routePath = path.replace(/\{(.*?)\}/g, ':$1');
  verbs[method](routePath)(FixtureController.prototype, name, descriptor);
  Req()(FixtureController.prototype, name, 0);
  Res()(FixtureController.prototype, name, 1);
  if (path.startsWith('/items')) UseGuards(FixturePolicy)(FixtureController.prototype, name, descriptor);
  if (operations.includes(operation)) SendproofPreview(method, path)(FixtureController.prototype, name, descriptor);
  if (storeRoutes.unavailable.includes(operation)) {
    SendproofPreview(method, path, { enabled: false, ...operation.options })(FixtureController.prototype, name, descriptor);
  }
}

class FixtureModule {}
Module({
  controllers: [FixtureController],
  imports: [SendproofModule.forRoot({
    ...fixtureJourneys,
    environment: scenario === 'disabled' ? 'production' : 'development',
    basePath, database: 'SQLite', openApiUrl: '/openapi.json', authProviders, previewProvider, traceTtlMs: 5000, dataStores: storeRoutes.dataStores,
    resolveIdentity: ({ headers }) => session(headers.cookie),
  })],
})(FixtureModule);

const app = await NestFactory.create(FixtureModule, { logger: ['error'] });
if (basePath) app.setGlobalPrefix(basePath.slice(1));
app.enableShutdownHooks(['SIGTERM']);
await app.listen(port, '127.0.0.1');
