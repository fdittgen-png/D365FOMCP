/**
 * Tests for validateLikePattern helper (issue #42).
 *
 * The helper guards LIKE-based searches across kb-tools and xref-tools
 * from runaway full-table scans triggered by oversized wildcard patterns.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateLikePattern, MAX_LIKE_PATTERN_LENGTH } from '../src/azure/shared.js';

describe('validateLikePattern', () => {
  it('exports the documented limit constant', () => {
    assert.equal(MAX_LIKE_PATTERN_LENGTH, 100);
  });

  it('returns null for short patterns', () => {
    assert.equal(validateLikePattern('CustTable'), null);
    assert.equal(validateLikePattern(''), null);
    assert.equal(validateLikePattern('a'.repeat(100)), null);
  });

  it('returns a structured error when over the default limit', () => {
    const result = validateLikePattern('a'.repeat(101));
    assert.deepEqual(result, { error: 'Search pattern too long (max 100 chars)' });
  });

  it('returns a structured error for very long patterns (full-scan scenario)', () => {
    const result = validateLikePattern('x'.repeat(500));
    assert.equal(result?.error, 'Search pattern too long (max 100 chars)');
  });

  it('honours a custom max', () => {
    assert.equal(validateLikePattern('abcdef', 10), null);
    assert.deepEqual(validateLikePattern('abcdefghijk', 10), {
      error: 'Search pattern too long (max 10 chars)',
    });
  });

  it('returns null for non-string input (Zod handles type errors upstream)', () => {
    assert.equal(validateLikePattern(undefined), null);
    assert.equal(validateLikePattern(null), null);
    assert.equal(validateLikePattern(42), null);
  });
});
