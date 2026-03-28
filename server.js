require('dotenv').config();
const express = require('express');
const path    = require('path');
const {
  checkAvailability,
  onLog,
  onScreenshot,
  getLatestScreenshot,
  clearScreenshot,
  validateConfig,
} = require('./poller');
const history = require('./history');

validateConfig();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Polling loop state ───────────────────────────────────────────────────────

let pollTimer       = null;
let pollInProgress  = false;
let intervalMinutes = parseInt(process.env.POLL_INTERVAL_MINUTES) || 30;

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
  clearScreenshot();
  try {
    await checkAvailability(triggeredBy);
  } finally {
    pollInProgress = false;
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

app.get('/status', (req, res) => {
  res.json({ pollInProgress, isPolling: pollTimer !== null, intervalMinutes });
});

// ─── History ──────────────────────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  res.json(history.getAll());
});

// ─── Screenshot stream (SSE) ──────────────────────────────────────────────────
// Sends a new frame whenever the browser captures a screenshot

app.get('/screenshot-stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  // Send the latest screenshot immediately if one exists
  const latest = getLatestScreenshot();
  if (latest.buf) {
    const b64 = latest.buf.toString('base64');
    res.write(`data: ${JSON.stringify({ img: b64, step: latest.step })}\n\n`);
  }

  const remove = onScreenshot((buf, step) => {
    const b64 = buf.toString('base64');
    res.write(`data: ${JSON.stringify({ img: b64, step })}\n\n`);
  });

  req.on('close', remove);
});

// ─── Latest screenshot (single fetch) ────────────────────────────────────────

app.get('/api/screenshot', (req, res) => {
  const { buf, step } = getLatestScreenshot();
  if (!buf) return res.status(404).json({ error: 'No screenshot yet' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('X-Step', step || '');
  res.send(buf);
});

// ─── Manual trigger ───────────────────────────────────────────────────────────

app.post('/poll', (req, res) => {
  if (pollInProgress) return res.status(429).json({ error: 'Poll already in progress.' });
  res.json({ message: 'Poll started' });
  runPoll('manual');
});

// ─── Stop / Start / Change interval ──────────────────────────────────────────

app.post('/poll/stop', (req, res) => {
  stopLoop();
  res.json({ message: 'Polling stopped', isPolling: false, intervalMinutes });
});

app.post('/poll/start', (req, res) => {
  startLoop();
  res.json({ message: 'Polling started', isPolling: true, intervalMinutes });
});

app.post('/poll/interval', (req, res) => {
  const mins = parseInt(req.body.minutes);
  if (!mins || mins < 1) return res.status(400).json({ error: 'minutes must be >= 1' });
  intervalMinutes = mins;
  if (pollTimer) startLoop();
  res.json({ message: `Interval set to ${mins} min`, isPolling: pollTimer !== null, intervalMinutes });
});

// ─── Log SSE stream ───────────────────────────────────────────────────────────

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

runPoll('schedule');
startLoop();
