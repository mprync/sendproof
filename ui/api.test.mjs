import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operations, makeRequest, execute } from './api.js';

globalThis.location = new URL('https://example.test/tenant/sendproof/');
globalThis.document = { baseURI: location.href };

test('discovers unrelated operations and builds a request with path and query parameters', () => {
  const [op] = operations({ paths: { '/widgets/{id}': { get: { summary: 'Find widget' } } } });
  const request = makeRequest(op, [{in:'path',name:'id',required:true,value:'a/b'}, {in:'query',name:'page',value:2}],undefined,{},'/tenant/');
  assert.equal(request.url,'https://example.test/tenant/widgets/a%2Fb?page=2');
  assert.throws(() => makeRequest(op,[],undefined,{},'/tenant/'),/path parameters/);
});

test('preview uses reserved route and refuses a missing rollback acknowledgement', async () => {
  let call;
  globalThis.fetch = async (url,options) => { call = {url,options}; return new Response('{}',{status:200}); };
  const request={method:'POST',url:'https://example.test/tenant/widgets?mode=one',headers:new Headers(),body:'{}'};
  await assert.rejects(execute(request,true,'/tenant/'),/not acknowledged/);
  assert.equal(call.url,'https://example.test/tenant/sendproof/_preview/widgets?mode=one');
  assert.equal(call.options.redirect,'error');
  assert.equal(call.options.credentials,'include');
  assert.equal(call.options.headers.get('Prefer'),'tx=rollback');
  globalThis.fetch = async () => new Response(JSON.stringify({status:201,body:{id:1},changes:[],effects:[],logs:[],rolledBack:true}));
  assert.equal((await execute(request,true,'/tenant/')).rolledBack,true);
});

test('serializes exploded arrays and deep object query parameters', () => {
  const op = {method:'GET',path:'/items'};
  const request = makeRequest(op,[{in:'query',name:'tag',value:['one','two']},{in:'query',name:'filter',style:'deepObject',value:{active:true}}],undefined,{},'/tenant/');
  const query = new URL(request.url).searchParams;
  assert.deepEqual(query.getAll('tag'),['one','two']);
  assert.equal(query.get('filter[active]'),'true');
});

test('observed Send keeps the original URL and collects optional trace evidence', async () => {
  const request = { method: 'POST', url: 'https://example.test/tenant/widgets', headers: { Prefer: 'return=representation' }, body: '{}' };
  const id = 'f8bb1c7235aa42378c7d127de3a0630c';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response('{"id":42}', {
      status: 201, headers: { 'X-Sendproof-Trace': id, 'Server-Timing': 'handler;dur=21', Location: '/tenant/widgets/42' },
    });
    return Response.json({ status: 999, logs: [{ level: 'Sql', message: 'inserted' }], timing: { handler: 21 } });
  };
  const result = await execute(request, false, '/tenant/', undefined, { observedSend: true });
  assert.equal(result.status, 201);
  assert.equal(result.body.id, 42);
  assert.equal(result.raw, '{"id":42}');
  assert.equal(result.traceId, id);
  assert.equal(result.serverTiming, 'handler;dur=21');
  assert.equal(result.logs[0].level, 'Sql');
  assert.equal(calls[0].url, request.url);
  assert.equal(calls[0].options.headers.get('Prefer'), 'return=representation, trace');
  assert.equal(calls[1].url, 'https://example.test/tenant/sendproof/_api/traces/' + id);
  assert.equal(calls[1].options.credentials, 'include');
});

test('a missing trace does not turn a completed Send into a retryable failure', async () => {
  const request = { method: 'POST', url: 'https://example.test/tenant/widgets', headers: {}, body: '{}' };
  let count = 0;
  globalThis.fetch = async () => ++count === 1 ? new Response('saved', {
    status: 201, headers: { 'X-Sendproof-Trace': 'f8bb1c7235aa42378c7d127de3a0630c' },
  }) : new Response('', { status: 404 });
  const result = await execute(request, false, '/tenant/', undefined, { observedSend: true });
  assert.equal(result.body, 'saved');
  assert.equal(result.traceId, undefined);
  assert.equal(result.status, 201);
});
