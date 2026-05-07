/**
 * Tests for d365taskrecorder upload size pre-check (issue #43).
 *
 * Verifies the Content-Length gate rejects oversized uploads before the
 * body is read into memory. The integration scenarios required by the
 * issue (60 MB → 413, 1 KB → 200) are covered at the size-decision level
 * here; the .axtr parsing path itself is exercised by
 * `test/taskrecorder-parser.test.js`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkUploadSize, MAX_UPLOAD_BYTES } from '../src/functions/d365taskrecorder.js';

describe('checkUploadSize (issue #43)', () => {
  it('exposes the documented 10 MB ceiling', () => {
    assert.equal(MAX_UPLOAD_BYTES, 10 * 1024 * 1024);
  });

  it('60 MB Content-Length → 413 (declared size > limit)', () => {
    const sixtyMb = String(60 * 1024 * 1024);
    const result = checkUploadSize(sixtyMb);
    assert.equal(result?.status, 413);
    assert.match(result.body, /exceeds 10 MB/i);
    assert.match(result.body, /60\.0 MB declared/);
  });

  it('1 KB Content-Length → null (request may proceed)', () => {
    const result = checkUploadSize(String(1024));
    assert.equal(result, null);
  });

  it('missing Content-Length → 413', () => {
    assert.equal(checkUploadSize(null)?.status, 413);
    assert.equal(checkUploadSize(undefined)?.status, 413);
    assert.equal(checkUploadSize('')?.status, 413);
  });

  it('invalid (non-numeric / negative) Content-Length → 413', () => {
    assert.equal(checkUploadSize('not-a-number')?.status, 413);
    assert.equal(checkUploadSize('-1')?.status, 413);
  });

  it('exactly at the limit → null (boundary)', () => {
    assert.equal(checkUploadSize(String(MAX_UPLOAD_BYTES)), null);
  });

  it('1 byte over the limit → 413', () => {
    assert.equal(checkUploadSize(String(MAX_UPLOAD_BYTES + 1))?.status, 413);
  });

  it('honours a custom max (defence-in-depth for callers tightening the limit)', () => {
    assert.equal(checkUploadSize('5000', 1024)?.status, 413);
    assert.equal(checkUploadSize('500', 1024), null);
  });
});
