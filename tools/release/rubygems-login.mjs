#!/usr/bin/env node
// Logs the publish-rubygems job in to RubyGems.org with trusted publishing.
//
// rubygems/configure-rubygems-credentials posts only the OIDC token to the exchange endpoint, but RubyGems.org also
// takes the numeric ID of the repository owner and rejects a gem's first push unless the workflow asserts it. This
// script does the same exchange with the owner added:
//
//   1. asks GitHub for an OIDC token for the audience rubygems.org (the job needs `permissions: id-token: write`),
//   2. posts { jwt, owner } to https://rubygems.org/api/v1/oidc/trusted_publisher/exchange_token,
//   3. masks the API key it gets back and exports it as GEM_HOST_API_KEY for the later steps of the job.
//
// RUBYGEMS_OWNER is the repository variable holding the owner's account ID. Neither token is ever printed.

import { appendFileSync } from 'node:fs';

const EXCHANGE = 'https://rubygems.org/api/v1/oidc/trusted_publisher/exchange_token';

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set${name.startsWith('ACTIONS_ID_TOKEN') ? '; the job needs "permissions: id-token: write"' : ''}`);
  return value;
}

async function fail(response, what) {
  // The body of a refusal names the reason (for example an unknown trusted publisher); it carries no secrets.
  const body = (await response.text()).slice(0, 500);
  throw new Error(`${what} failed: HTTP ${response.status}${body ? ` ${body}` : ''}`);
}

try {
  const requestUrl = new URL(need('ACTIONS_ID_TOKEN_REQUEST_URL'));
  requestUrl.searchParams.set('audience', 'rubygems.org');
  const issued = await fetch(requestUrl, {
    headers: { Authorization: `Bearer ${need('ACTIONS_ID_TOKEN_REQUEST_TOKEN')}`, Accept: 'application/json' },
  });
  if (!issued.ok) await fail(issued, 'Requesting the GitHub OIDC token');
  const jwt = (await issued.json()).value;
  if (!jwt) throw new Error('GitHub returned no OIDC token');
  console.log(`::add-mask::${jwt}`);

  const owner = process.env.RUBYGEMS_OWNER?.trim();
  const exchanged = await fetch(EXCHANGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(owner ? { jwt, owner } : { jwt }),
  });
  if (!exchanged.ok) await fail(exchanged, 'The RubyGems.org token exchange');
  const key = (await exchanged.json()).rubygems_api_key;
  if (!key) throw new Error('RubyGems.org returned no API key');

  console.log(`::add-mask::${key}`);
  appendFileSync(need('GITHUB_ENV'), `GEM_HOST_API_KEY=${key}\n`);
  console.log(`Logged in to RubyGems.org by trusted publishing${owner ? ` (owner ${owner})` : ' (no owner asserted: set the RUBYGEMS_OWNER repository variable)'}.`);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
