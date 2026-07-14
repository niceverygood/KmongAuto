const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(WORKSPACE, 'scripts');
const TEMP_DIR = path.join(WORKSPACE, 'temp');
const LOGS_DIR = path.join(WORKSPACE, 'logs');
const DATA_DIR = path.join(WORKSPACE, 'data');
const CONFIG_DIR = path.join(WORKSPACE, 'config');
const PROPOSALS_DIR = path.join(WORKSPACE, 'proposals');

module.exports = { WORKSPACE, SCRIPTS_DIR, TEMP_DIR, LOGS_DIR, DATA_DIR, CONFIG_DIR, PROPOSALS_DIR };
