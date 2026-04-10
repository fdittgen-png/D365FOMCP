/**
 * Azure Blob Storage helper for large file uploads.
 *
 * Uses the Function App's existing storage account (AzureWebJobsStorage) to
 * provide SAS-based direct upload from browsers and PowerAutomate. This
 * bypasses the 230-second Azure front-end proxy timeout for large files.
 *
 * Container: secbuild-uploads (auto-created)
 */

import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  ContainerSASPermissions,
} from '@azure/storage-blob';

const CONTAINER_NAME = 'secbuild-uploads';
let _serviceClient = null;
let _credential = null;
let _accountName = null;

/**
 * Parse the AzureWebJobsStorage connection string and initialize clients.
 * Falls back to local development defaults.
 */
function getClients() {
  if (_serviceClient) return { serviceClient: _serviceClient, credential: _credential, accountName: _accountName };

  const connStr = process.env.AzureWebJobsStorage || '';
  if (!connStr || connStr === 'UseDevelopmentStorage=true') {
    throw new Error('Blob storage not available (AzureWebJobsStorage not configured or using development storage).');
  }

  // Parse connection string for account name and key
  const parts = Object.fromEntries(
    connStr.split(';').filter(Boolean).map(part => {
      const idx = part.indexOf('=');
      return [part.substring(0, idx), part.substring(idx + 1)];
    }),
  );

  _accountName = parts.AccountName;
  const accountKey = parts.AccountKey;
  if (!_accountName || !accountKey) {
    throw new Error('Invalid AzureWebJobsStorage: missing AccountName or AccountKey.');
  }

  _credential = new StorageSharedKeyCredential(_accountName, accountKey);
  _serviceClient = new BlobServiceClient(
    `https://${_accountName}.blob.core.windows.net`,
    _credential,
  );

  return { serviceClient: _serviceClient, credential: _credential, accountName: _accountName };
}

/** Ensure the upload container exists (idempotent). */
export async function ensureContainer() {
  const { serviceClient } = getClients();
  const container = serviceClient.getContainerClient(CONTAINER_NAME);
  await container.createIfNotExists();
}

/**
 * Generate a SAS URL that allows the client to upload a blob directly.
 * @param {string} blobName - Blob path (e.g. "job-abc123/export.zip")
 * @param {number} [expiryMinutes=60] - SAS token validity in minutes
 * @returns {string} Full URL with SAS token
 */
export function generateUploadSasUrl(blobName, expiryMinutes = 60) {
  const { credential, accountName } = getClients();

  const startsOn = new Date();
  startsOn.setMinutes(startsOn.getMinutes() - 5); // 5 min clock skew buffer
  const expiresOn = new Date();
  expiresOn.setMinutes(expiresOn.getMinutes() + expiryMinutes);

  const sasToken = generateBlobSASQueryParameters({
    containerName: CONTAINER_NAME,
    blobName,
    permissions: BlobSASPermissions.parse('cw'), // create + write
    startsOn,
    expiresOn,
  }, credential).toString();

  return `https://${accountName}.blob.core.windows.net/${CONTAINER_NAME}/${blobName}?${sasToken}`;
}

/**
 * Download a blob to a local file path (streaming).
 * @param {string} blobName - Blob path
 * @param {string} filePath - Local destination path
 */
export async function downloadBlobToFile(blobName, filePath) {
  const { serviceClient } = getClients();
  const blobClient = serviceClient
    .getContainerClient(CONTAINER_NAME)
    .getBlobClient(blobName);
  await blobClient.downloadToFile(filePath);
}

/**
 * Delete a blob (cleanup after build).
 * @param {string} blobName - Blob path
 */
export async function deleteBlob(blobName) {
  const { serviceClient } = getClients();
  try {
    await serviceClient
      .getContainerClient(CONTAINER_NAME)
      .getBlobClient(blobName)
      .deleteIfExists();
  } catch { /* ignore cleanup errors */ }
}

/**
 * Get the storage account name (for CORS configuration info).
 */
export function getStorageAccountName() {
  try {
    const { accountName } = getClients();
    return accountName;
  } catch {
    return null;
  }
}
