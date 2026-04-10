/**
 * In-memory async job tracker for security database builds.
 *
 * Tracks build operations through their lifecycle:
 *   pending → downloading → extracting → building → completed | failed
 *
 * On a single-instance App Service plan this is reliable. If the instance
 * restarts, in-progress jobs are lost but the database is never corrupted
 * (sec-builder.js writes to a .tmp file and atomically renames).
 */

import { randomUUID } from 'crypto';

/** @type {Map<string, object>} */
const jobs = new Map();

const MAX_JOBS = 20;
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Create a new build job.
 * @param {object} [metadata] - Extra info (uploadedBy, blobName, sourceUrl)
 * @returns {object} The new job record
 */
export function createJob(metadata = {}) {
  cleanup();

  // Only one ACTIVELY RUNNING build at a time. Pending jobs are SAS-issued
  // but never triggered — those don't count as "in progress".
  for (const job of jobs.values()) {
    if (['downloading', 'extracting', 'building'].includes(job.status)) {
      throw new Error(`Build already in progress (job ${job.id}, status: ${job.status}).`);
    }
  }

  const job = {
    id: randomUUID().split('-')[0], // short ID
    status: 'pending',
    progress: null,
    error: null,
    result: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...metadata,
  };

  jobs.set(job.id, job);
  return job;
}

/**
 * Get a job by ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getJob(id) {
  return jobs.get(id) || null;
}

/**
 * Update a job's state.
 * @param {string} id
 * @param {object} updates - Fields to merge (status, progress, error, result)
 */
export function updateJob(id, updates) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, updates, { updatedAt: new Date().toISOString() });
}

/** Remove old completed/failed jobs. */
function cleanup() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - new Date(job.createdAt).getTime() > MAX_AGE_MS) {
      jobs.delete(id);
    }
  }
  // Cap total jobs
  if (jobs.size > MAX_JOBS) {
    const sorted = [...jobs.entries()].sort((a, b) =>
      new Date(a[1].createdAt) - new Date(b[1].createdAt));
    for (let i = 0; i < sorted.length - MAX_JOBS; i++) {
      jobs.delete(sorted[i][0]);
    }
  }
}
