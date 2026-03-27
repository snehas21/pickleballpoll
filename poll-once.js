/**
 * Single-run mode — used by GitHub Actions.
 * Runs one availability check and exits with code 0 (no spots) or 0 (spots found + email sent).
 * Exits with code 1 on error.
 */
require('dotenv').config();
const { checkAvailability, validateConfig } = require('./poller');

validateConfig();

checkAvailability()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Poll failed:', err.message);
    process.exit(1);
  });
