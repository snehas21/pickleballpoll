require('dotenv').config();
const express = require('express');
const path    = require('path');
const { checkAvailability, onLog, startPollingLoop, validateConfig } = require('./poller');

validateConfig();

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Static UI ────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Manual poll trigger ──────────────────────────────────────────────────────
let pollInProgress = false;

app.post('/poll', async (req, res) => {
  if (pollInProgress) {
    return res.status(429).json({ error: 'Poll already in progress, please wait.' });
  }
  pollInProgress = true;
  res.json({ message: 'Poll started' });

  try {
    await checkAvailability();
  } finally {
    pollInProgress = false;
  }
});

// ─── Server-Sent Events: stream log lines to the browser ──────────────────────
app.get('/log-stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const remove = onLog(line => {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  });

  req.on('close', remove);
});

// ─── Poll status ──────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({ pollInProgress });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏓 Pickleball Poller web UI → http://localhost:${PORT}\n`);
});

// Start the background 30-minute polling loop
startPollingLoop();
