/**
 * Per-request client preferences (W2 #106, W4 #108).
 *
 * Resolution order (highest first): query > header > env > clientInfo policy >
 * default. Unknown values fall THROUGH, never error. The AsyncLocalStorage
 * store must not leak between two requests in flight at the same time — that
 * is the whole reason it is per-request rather than per-process.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePreferences, preferencesFromHttpRequest, describePreferences,
  runWithRequestContext, getRequestContext, setProcessRequestContext,
  normalizeProfile, normalizeTextChannel,
  CLIENT_TEXT_CHANNEL_POLICY, DEFAULT_PREFERENCES,
  HEADER_PROFILE, HEADER_TEXT_CHANNEL, ENV_PROFILE, ENV_TEXT_CHANNEL,
} from '../src/azure/request-context.js';

const noEnv = {};

describe('resolvePreferences — resolution order', () => {
  it('defaults to full/full with nothing set', () => {
    const p = resolvePreferences({ env: noEnv });
    assert.equal(p.profile, 'full');
    assert.equal(p.textChannel, 'full');
    assert.deepEqual(p.sources, { profile: 'default', textChannel: 'default' });
    assert.deepEqual(DEFAULT_PREFERENCES, { profile: 'full', textChannel: 'full' });
  });

  it('env is read when nothing more specific is present', () => {
    const p = resolvePreferences({ env: { [ENV_PROFILE]: 'core', [ENV_TEXT_CHANNEL]: 'summary' } });
    assert.equal(p.profile, 'core');
    assert.equal(p.textChannel, 'summary');
    assert.deepEqual(p.sources, { profile: 'env', textChannel: 'env' });
  });

  it('header beats env', () => {
    const headers = new Headers({ [HEADER_PROFILE]: 'core', [HEADER_TEXT_CHANNEL]: 'summary' });
    const p = resolvePreferences({ headers, env: { [ENV_PROFILE]: 'full', [ENV_TEXT_CHANNEL]: 'full' } });
    assert.equal(p.profile, 'core');
    assert.equal(p.textChannel, 'summary');
    assert.deepEqual(p.sources, { profile: 'header', textChannel: 'header' });
  });

  it('query beats header', () => {
    const headers = new Headers({ [HEADER_PROFILE]: 'core', [HEADER_TEXT_CHANNEL]: 'summary' });
    const p = resolvePreferences({ headers, query: 'https://x/api/d365kb?profile=full&text=full', env: noEnv });
    assert.equal(p.profile, 'full');
    assert.equal(p.textChannel, 'full');
    assert.deepEqual(p.sources, { profile: 'query', textChannel: 'query' });
  });

  it('accepts URLSearchParams, a plain object, and a plain-object header bag', () => {
    assert.equal(resolvePreferences({ query: new URLSearchParams('profile=core'), env: noEnv }).profile, 'core');
    assert.equal(resolvePreferences({ query: { text: 'summary' }, env: noEnv }).textChannel, 'summary');
    assert.equal(resolvePreferences({ headers: { 'X-MCP-Tool-Profile': 'CORE' }, env: noEnv }).profile, 'core',
      'header lookup is case-insensitive on name and value');
  });

  it('an unknown value at one level falls through to the next, never errors', () => {
    const headers = new Headers({ [HEADER_PROFILE]: 'core' });
    const p = resolvePreferences({ headers, query: '?profile=minimal-typo&text=json', env: { [ENV_TEXT_CHANNEL]: 'summary' } });
    assert.equal(p.profile, 'core', 'query typo -> header wins');
    assert.equal(p.textChannel, 'summary', 'query typo -> env wins');
    assert.deepEqual(p.sources, { profile: 'header', textChannel: 'env' });

    const bad = resolvePreferences({ env: { [ENV_PROFILE]: 'nope', [ENV_TEXT_CHANNEL]: 'nope' } });
    assert.equal(bad.profile, 'full');
    assert.equal(bad.textChannel, 'full');
  });

  it('clientInfo policy sits below env and above the default (text channel only)', () => {
    const policy = { 'measured-client': 'summary' };
    const byPolicy = resolvePreferences({ env: noEnv, clientInfo: { name: 'Measured-Client' }, policy });
    assert.equal(byPolicy.textChannel, 'summary');
    assert.equal(byPolicy.sources.textChannel, 'client-policy');
    assert.equal(byPolicy.clientName, 'Measured-Client');
    assert.equal(byPolicy.profile, 'full', 'the policy table never touches the profile');

    const envWins = resolvePreferences({ env: { [ENV_TEXT_CHANNEL]: 'full' }, clientInfo: { name: 'measured-client' }, policy });
    assert.equal(envWins.textChannel, 'full');
    assert.equal(envWins.sources.textChannel, 'env');

    const unknownClient = resolvePreferences({ env: noEnv, clientInfo: { name: 'someone-else' }, policy });
    assert.equal(unknownClient.textChannel, 'full');
  });

  it('the shipped policy table is EMPTY until #108 records the client measurement', () => {
    assert.deepEqual(CLIENT_TEXT_CHANNEL_POLICY, {});
    assert.ok(Object.isFrozen(CLIENT_TEXT_CHANNEL_POLICY));
    const p = resolvePreferences({ env: noEnv, clientInfo: { name: 'claude-ai' } });
    assert.equal(p.textChannel, 'full', 'no client is pre-judged');
  });

  it('normalizers return null for anything not in the enum', () => {
    assert.equal(normalizeProfile(' Core '), 'core');
    assert.equal(normalizeProfile('minimal'), null);
    assert.equal(normalizeProfile(undefined), null);
    assert.equal(normalizeTextChannel('SUMMARY'), 'summary');
    assert.equal(normalizeTextChannel('json'), null);
  });

  it('preferencesFromHttpRequest reads an Azure/Fetch-shaped request', () => {
    const request = {
      url: 'https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb?profile=core',
      headers: new Headers({ [HEADER_TEXT_CHANNEL]: 'summary', accept: 'application/json' }),
    };
    const p = preferencesFromHttpRequest(request, noEnv);
    assert.equal(p.profile, 'core');
    assert.equal(p.textChannel, 'summary');
    assert.match(describePreferences(p), /^profile=core\(query\) text=summary\(header\)$/);
  });
});

describe('request context — AsyncLocalStorage', () => {
  afterEach(() => setProcessRequestContext(null));

  it('outside any context it resolves from the environment', () => {
    const saved = process.env[ENV_PROFILE];
    try {
      process.env[ENV_PROFILE] = 'core';
      assert.equal(getRequestContext().profile, 'core');
      delete process.env[ENV_PROFILE];
      assert.equal(getRequestContext().profile, 'full');
    } finally {
      if (saved === undefined) delete process.env[ENV_PROFILE]; else process.env[ENV_PROFILE] = saved;
    }
  });

  it('the process context (stdio) is the fallback beneath a request store', async () => {
    setProcessRequestContext({ profile: 'core', textChannel: 'summary' });
    assert.equal(getRequestContext().profile, 'core');
    assert.equal(getRequestContext().textChannel, 'summary');
    await runWithRequestContext({ profile: 'full', textChannel: 'full' }, async () => {
      assert.equal(getRequestContext().profile, 'full', 'a request store shadows the process context');
    });
    assert.equal(getRequestContext().profile, 'core', 'and is gone once the request returns');
  });

  it('two concurrent requests each see their own preferences across awaits', async () => {
    const tick = () => new Promise(r => setTimeout(r, 2));
    const seen = { a: [], b: [] };

    const a = runWithRequestContext({ profile: 'core', textChannel: 'summary' }, async () => {
      for (let i = 0; i < 5; i++) { await tick(); seen.a.push(getRequestContext().profile + '/' + getRequestContext().textChannel); }
      return getRequestContext();
    });
    const b = runWithRequestContext({ profile: 'full', textChannel: 'full' }, async () => {
      for (let i = 0; i < 5; i++) { await tick(); seen.b.push(getRequestContext().profile + '/' + getRequestContext().textChannel); }
      return getRequestContext();
    });
    const [ra, rb] = await Promise.all([a, b]);

    assert.deepEqual(seen.a, Array(5).fill('core/summary'));
    assert.deepEqual(seen.b, Array(5).fill('full/full'));
    assert.equal(ra.profile, 'core');
    assert.equal(rb.profile, 'full');
    assert.equal(getRequestContext().profile, 'full', 'nothing leaks out of either request');
  });

  it('the store is frozen — a tool cannot rewrite the request preferences', () => {
    runWithRequestContext({ profile: 'core', textChannel: 'full' }, () => {
      const ctx = getRequestContext();
      assert.ok(Object.isFrozen(ctx));
      assert.throws(() => { 'use strict'; ctx.profile = 'full'; });
    });
  });
});
