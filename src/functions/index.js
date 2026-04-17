/**
 * Azure Functions entry point.
 * Imports all function registrations so the runtime discovers them.
 */

import { app } from '@azure/functions';
app.setup({ enableHttpStream: true });

import './d365kb.js';
import './d365xref.js';
import './d365sec.js';
import './d365sec-upload.js';
import './d365taskrecorder.js';
import './otrs-extract.js';
import './otrs-ingest.js';
import './otrs-admin.js';
import './wiki-mcp.js';
