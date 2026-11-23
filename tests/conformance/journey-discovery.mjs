import assert from 'node:assert/strict';

/** Checks Contract 2 for a fixture that advertises journeys; base is '' or a mount such as '/tenant'. */
export async function journeyDiscovery(t, request, schemas, capabilities, base = '') {
  await t.test('Journey discovery and documents', {
    skip: capabilities.journeys === undefined ? 'Fixture does not advertise journeys' : false,
  }, async () => {
    const journeys = capabilities.journeys;
    assert(Array.isArray(journeys), 'Advertised journeys must be an array');
    assert(journeys.length > 0, 'A fixture advertising journeys must list at least one document');
    assert(base === '' || /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/.test(base), `Invalid application base: ${base}`);

    const origin = 'http://conformance.invalid';
    const localPath = value => {
      const url = new URL(value, origin);
      assert.equal(url.origin, origin, 'Journey URLs must be local');
      assert.equal(url.search, '', `Journey URLs must not have a query: ${value}`);
      assert.equal(url.hash, '', `Journey URLs must not have a fragment: ${value}`);
      assert(url.pathname.startsWith(base + '/sendproof/'), `Journey URL must stay under the mount ${base}: ${value}`);
      return url.pathname;
    };
    const documentName = (path, extension) => {
      const prefix = `${base}/sendproof/journeys/`;
      assert(path.startsWith(prefix), `Journey document is outside its route: ${path}`);
      const name = path.slice(prefix.length);
      assert.match(name, extension === 'arazzo' ? /^[^/]+\.arazzo\.json$/ : /^[^/]+\.expect\.json$/,
        `Unmatched journey document route: ${path}`);
      return name;
    };

    for (const entry of journeys) {
      assert.equal(typeof entry.name, 'string');
      assert(entry.name.length > 0);
      assert(['code', 'file'].includes(entry.source), `Unknown journey source: ${entry.source}`);
      const arazzoPath = localPath(entry.arazzoUrl);
      const expectationsPath = localPath(entry.expectationsUrl);
      const arazzoName = documentName(arazzoPath, 'arazzo');
      const expectationsName = documentName(expectationsPath, 'expect');
      assert.equal(expectationsName, arazzoName.replace(/\.arazzo\.json$/, '.expect.json'),
        'The Arazzo and expectations routes must share a document name');

      const arazzoResponse = await request(arazzoPath);
      assert.equal(arazzoResponse.status, 200, `Could not fetch Arazzo document ${arazzoPath}`);
      const document = await arazzoResponse.json();
      schemas.assert('arazzo', document);
      assert.equal(document.arazzo, '1.1.0');
      assert(document.sourceDescriptions?.some(source => source.url === capabilities.openApiUrl),
        `${arazzoPath} must reference the discovered OpenAPI document`);
      assert(Array.isArray(document.workflows) && document.workflows.length > 0,
        `${arazzoPath} must contain at least one workflow`);
      const workflowIds = new Set();
      for (const workflow of document.workflows) {
        assert(!workflowIds.has(workflow.workflowId), `Duplicate workflow ID ${workflow.workflowId} in ${arazzoPath}`);
        workflowIds.add(workflow.workflowId);
      }

      const expectationsResponse = await request(expectationsPath);
      assert.equal(expectationsResponse.status, 200, `Could not fetch expectations document ${expectationsPath}`);
      const expectations = await expectationsResponse.json();
      assert.equal(expectations.sendproofExpectations, '1.0');
      assert.equal(expectations.arazzo, arazzoName);
      assert(expectations.journeys && typeof expectations.journeys === 'object' && !Array.isArray(expectations.journeys));

      // The engine shares this URL directory with the documents. It must still resolve to its JavaScript module.
      const enginePath = arazzoPath.replace(/[^/]+\.arazzo\.json$/, 'index.js');
      const engineResponse = await request(enginePath);
      assert.equal(engineResponse.status, 200, `Journey engine asset was shadowed at ${enginePath}`);
      assert.match(engineResponse.headers.get('content-type') ?? '', /javascript/);
      assert.match(await engineResponse.text(), /export\s*\{/);

      for (const unmatched of ['not-registered.arazzo.json', 'not-registered.expect.json']) {
        const route = `${base}/sendproof/journeys/${unmatched}`;
        assert.notEqual(route, arazzoPath);
        assert.notEqual(route, expectationsPath);
        const response = await request(route);
        assert.equal(response.status, 404, `Unregistered journey document route must be rejected: ${route}`);
        await response.body?.cancel();
      }
    }
  });
}
