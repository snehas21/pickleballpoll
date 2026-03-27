require('dotenv').config();
const express = require('express');
const path    = require('path');
const { checkAvailability, onLog, validateConfig } = require('./poller');
const history = require('./history');

validateConfig();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Polling loop state ───────────────────────────────────────────────────────

let pollTimer           = null;
let pollInProgress      = false;
let intervalMinutes     = parseInt(process.env.POLL_INTERVAL_MINUTES) || 30;

function startLoop() {
  stopLoop();
  pollTimer = setInterval(() => runPoll('schedule'), intervalMinutes * 60 * 1000);
}

function stopLoop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function runPoll(triggeredBy) {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    await checkAvailability(triggeredBy);
  } finally {
    pollInProgress = false;
  }
}

// ─── API endpoints ────────────────────────────────────────────────────────────

// Status
app.get('/status', (req, res) => {
  res.json({
    pollInProgress,
    isPolling:       pollTimer !== null,
    intervalMinutes,
  });
});

// History
app.get('/api/history', (req, res) => {
  res.json(history.getAll());
});

// Manual trigger
app.post('/poll', (req, res) => {
  if (pollInProgress) return res.status(429).json({ error: 'Poll already in progress.' });
  res.json({ message: 'Poll started' });
  runPoll('manual');
});

// Stop the scheduled loop
app.post('/poll/stop', (req, res) => {
  stopLoop();
  res.json({ message: 'Polling stopped', isPolling: false, intervalMinutes });
});

// Start (or restart) the scheduled loop
app.post('/poll/start', (req, res) => {
  startLoop();
  res.json({ message: 'Polling started', isPolling: true, intervalMinutes });
});

// Change interval (minutes, min 1)
app.post('/poll/interval', (req, res) => {
  const mins = parseInt(req.body.minutes);
  if (!mins || mins < 1) return res.status(400).json({ error: 'minutes must be >= 1' });
  intervalMinutes = mins;
  if (pollTimer) startLoop();          // restart with new interval if already running
  res.json({ message: `Interval set to ${mins} min`, isPolling: pollTimer !== null, intervalMinutes });
});

// ─── SSE log stream ───────────────────────────────────────────────────────────

app.get('/log-stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  const remove = onLog(line => res.write(`data: ${JSON.stringify(line)}\n\n`));
  req.on('close', remove);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🏓 Pickleball Poller web UI → http://localhost:${PORT}\n`);
});

// Run immediately on startup, then start the loop
runPoll('schedule');
startLoop();
