/**
 * Azure Functions entry point.
 * Imports all function registrations so the runtime discovers them.
 */

import './d365kb.js';
import './d365xref.js';
import './d365sec.js';
import './d365sec-upload.js';
import './d365taskrecorder.js';
