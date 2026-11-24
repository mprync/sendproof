// The MCP server: the conventional lifecycle (initialize, notifications/initialized, then
// tools/list, tools/call, resources/list and resources/read) over any transport the SDK offers.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SendproofClient, type ClientOptions } from './client.js';
import { callTool, listTools, type SendPolicy, type ToolContext } from './tools.js';
import type { JsonObject } from './openapi.js';

export const VERSION = '0.1.0-alpha.2';

export interface ServerOptions extends ClientOptions {
  /** Whether send_request may commit: never, only when the API reports Development, or anywhere. */
  allowSend?: SendPolicy;
}

const INSTRUCTIONS = `Sendproof lets you explore and exercise an API the way its workbench does.
Start with get_api, then list_operations and describe_operation. Use find_values to get real IDs (customers, orders) for lookup fields instead of inventing them.
Prefer preview_request: it runs the real handler and rolls it back, and shows exactly what would have been written (rows before and after), the effects (emails, messages) and the logs and SQL. Nothing is written.
send_request commits. GET, HEAD and OPTIONS are always allowed; other methods need the server started with --allow-send and confirmSend: true.
Use list_personas and switch_persona to act as different development users.`;

export function createServer(options: ServerOptions) {
  const client = new SendproofClient(options);
  const server = new Server(
    { name: 'sendproof', title: 'Sendproof', version: VERSION },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } }, instructions: INSTRUCTIONS },
  );
  const context: ToolContext = {
    client,
    allowSend: options.allowSend ?? 'off',
    toolsChanged: () => {
      // Only a connected client can be told; before that, tools/list will reflect the change anyway.
      server.sendToolListChanged().catch(() => {});
      server.sendResourceListChanged().catch(() => {});
    },
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools(context) as never }));
  server.setRequestHandler(CallToolRequestSchema, async request => callTool(request.params.name, (request.params.arguments ?? {}) as JsonObject, context) as never);

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [{ uri: 'sendproof://capabilities', name: 'capabilities', title: 'Sendproof capabilities', mimeType: 'application/json', description: 'What the adapter offers: environment, stores, previewable operations, sign-in.' }];
    try {
      for (const document of await client.documents()) {
        resources.push({ uri: `sendproof://openapi/${encodeURIComponent(document.name)}`, name: `openapi-${document.name}`, title: `${document.name} OpenAPI document`, mimeType: 'application/json', description: `The full OpenAPI document served at ${document.url}.` });
      }
    } catch { /* The API may be down; capabilities still lists, and reading it says why. */ }
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const uri = request.params.uri;
    if (uri === 'sendproof://capabilities') {
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.capabilities(true), null, 2) }] };
    }
    const match = /^sendproof:\/\/openapi\/(.+)$/.exec(uri);
    if (match) {
      const name = decodeURIComponent(match[1]);
      const document = (await client.documents()).find(d => d.name === name);
      if (document) return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(document.document, null, 2) }] };
    }
    throw new Error(`No resource ${uri}.`);
  });

  return { server, client, context };
}
