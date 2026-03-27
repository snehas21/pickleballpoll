const fs   = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'runs.json');
const MAX_RUNS     = 100;

function load() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(runs) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(runs, null, 2));
}

/** Start a new run record; returns the run object (mutate it, then call finish). */
function startRun() {
  const run = {
    id:          Date.now().toString(),
    startedAt:   new Date().toISOString(),
    finishedAt:  null,
    status:      'running',   // running | success | no_spots | error
    spotsFound:  [],
    emailSent:   false,
    error:       null,
    triggeredBy: 'schedule',  // 'schedule' | 'manual'
  };

  const runs = load();
  runs.unshift(run);
  if (runs.length > MAX_RUNS) runs.splice(MAX_RUNS);
  save(runs);

  return run;
}

/** Persist the final state of a run after checkAvailability completes. */
function finishRun(run) {
  run.finishedAt = new Date().toISOString();

  const runs = load();
  const idx  = runs.findIndex(r => r.id === run.id);
  if (idx !== -1) runs[idx] = run;
  else runs.unshift(run);

  if (runs.length > MAX_RUNS) runs.splice(MAX_RUNS);
  save(runs);
}

function getAll() {
  return load();
}

module.exports = { startRun, finishRun, getAll };
