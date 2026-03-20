require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Config (loaded from .env) ---
const CONFIG = {
  email: process.env.PICKLEBALL_EMAIL || '',
  password: process.env.PICKLEBALL_PASSWORD || '',
  baseUrl: 'https://ca.apm.activecommunities.com/richmondhill',
  searchKeyword: 'Pickleball',
  ageFrom: 40,
  ageTo: 50,
};

// --- State ---
let pollState = {
  running: false,
  iteration: 0,
  total: 0,
  intervalMinutes: 0,
  logs: [],
  results: [],
  nextPollInSeconds: null,
};

let pollTimeout = null;
let countdownInterval = null;
const sseClients = new Set();

// --- SSE Broadcast ---
function broadcast(event) {
  if (event.message) {
    pollState.logs.push({ time: new Date().toLocaleTimeString('en-CA'), ...event });
    if (pollState.logs.length > 200) pollState.logs = pollState.logs.slice(-200);
  }
  const payload = JSON.stringify({ ...event, state: pollState });
  sseClients.forEach(res => {
    try { res.write(`data: ${payload}\n\n`); } catch (_) {}
  });
}

// --- Routes ---

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  // Send current state immediately on connect
  res.write(`data: ${JSON.stringify({ type: 'init', state: pollState })}\n\n`);

  req.on('close', () => sseClients.delete(res));
});

app.post('/api/start', (req, res) => {
  const { pollCount, intervalMinutes } = req.body;

  if (pollState.running) {
    return res.json({ error: 'A poll is already running. Stop it first.' });
  }

  const count = parseInt(pollCount, 10);
  const interval = parseFloat(intervalMinutes);

  if (!count || count < 1 || !interval || interval < 0.5) {
    return res.json({ error: 'Poll count must be ≥ 1 and interval must be ≥ 0.5 minutes.' });
  }

  pollState = {
    running: true,
    iteration: 0,
    total: count,
    intervalMinutes: interval,
    logs: [],
    results: [],
    nextPollInSeconds: null,
  };

  res.json({ success: true });
  runNextPoll(count, interval);
});

app.post('/api/stop', (req, res) => {
  stopPolling('Polling stopped by user.');
  res.json({ success: true });
});

app.get('/api/state', (req, res) => res.json(pollState));

app.listen(3000, () => {
  console.log('Pickleball Poller running → http://localhost:3000');
  if (!CONFIG.email) console.warn('WARNING: PICKLEBALL_EMAIL not set in .env');
  if (!CONFIG.password) console.warn('WARNING: PICKLEBALL_PASSWORD not set in .env');
});

// --- Poll orchestration ---

function stopPolling(reason) {
  if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  pollState.running = false;
  pollState.nextPollInSeconds = null;
  broadcast({ type: 'stopped', message: reason });
}

async function runNextPoll(totalPolls, intervalMinutes) {
  if (!pollState.running || pollState.iteration >= totalPolls) {
    pollState.running = false;
    pollState.nextPollInSeconds = null;
    broadcast({ type: 'complete', message: `All ${pollState.iteration} poll(s) finished.` });
    return;
  }

  pollState.iteration++;
  broadcast({ type: 'poll_start', message: `── Poll ${pollState.iteration} / ${totalPolls} starting ──` });

  try {
    const spots = await checkForPickleballSpots();
    if (spots.length > 0) {
      pollState.results.push(...spots);
      broadcast({
        type: 'found',
        message: `🎉 ${spots.length} open spot(s) found!`,
        results: spots,
      });
    } else {
      broadcast({ type: 'no_results', message: 'No open spots found this time.' });
    }
  } catch (err) {
    broadcast({ type: 'error', message: `Scraper error: ${err.message}` });
  }

  if (!pollState.running) return;

  if (pollState.iteration >= totalPolls) {
    pollState.running = false;
    pollState.nextPollInSeconds = null;
    broadcast({ type: 'complete', message: `All ${totalPolls} poll(s) finished.` });
    return;
  }

  // Countdown to next poll
  let secondsLeft = Math.round(intervalMinutes * 60);
  pollState.nextPollInSeconds = secondsLeft;
  broadcast({ type: 'waiting', message: `Waiting ${intervalMinutes} min until next poll…` });

  countdownInterval = setInterval(() => {
    if (!pollState.running) { clearInterval(countdownInterval); return; }
    secondsLeft--;
    pollState.nextPollInSeconds = secondsLeft;
    broadcast({ type: 'tick' }); // silent tick to update UI countdown
  }, 1000);

  pollTimeout = setTimeout(async () => {
    clearInterval(countdownInterval);
    countdownInterval = null;
    pollState.nextPollInSeconds = null;
    await runNextPoll(totalPolls, intervalMinutes);
  }, intervalMinutes * 60 * 1000);
}

// --- Playwright scraper ---

async function checkForPickleballSpots() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    broadcast({ type: 'log', message: 'Loading website…' });
    await page.goto(`${CONFIG.baseUrl}/Home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    broadcast({ type: 'log', message: 'Signing in…' });
    await login(page);

    broadcast({ type: 'log', message: 'Navigating to Activity Registration…' });
    await goToActivitySearch(page);

    broadcast({ type: 'log', message: `Searching for "${CONFIG.searchKeyword}" (age ${CONFIG.ageFrom}–${CONFIG.ageTo})…` });
    await fillSearchForm(page);

    broadcast({ type: 'log', message: 'Parsing results…' });
    return await extractOpenSpots(page);
  } finally {
    await browser.close();
  }
}

// ── Login ──────────────────────────────────────────────────────────────────

async function login(page) {
  // Click sign-in trigger (button or link)
  const signInTriggers = [
    'a:has-text("Sign In")',
    'button:has-text("Sign In")',
    'a:has-text("Log In")',
    'a[href*="signin"]',
    'a[href*="login"]',
    '.an-signin-link',
    '#signin-link',
  ];
  for (const sel of signInTriggers) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); await page.waitForTimeout(1500); break; }
    } catch (_) {}
  }

  // Email field
  const emailFields = [
    'input[type="email"]',
    'input[name="email"]',
    'input[id*="email" i]',
    'input[placeholder*="email" i]',
    '#Email',
  ];
  for (const sel of emailFields) {
    try {
      const el = await page.$(sel);
      if (el) { await el.fill(CONFIG.email); break; }
    } catch (_) {}
  }

  // Password field
  const pwFields = [
    'input[type="password"]',
    'input[name="password"]',
    'input[id*="password" i]',
    '#Password',
  ];
  for (const sel of pwFields) {
    try {
      const el = await page.$(sel);
      if (el) { await el.fill(CONFIG.password); break; }
    } catch (_) {}
  }

  // Submit
  const submitBtns = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign In")',
    'button:has-text("Log In")',
    'button:has-text("Login")',
    '.login-btn',
    '#login-btn',
  ];
  for (const sel of submitBtns) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); break; }
    } catch (_) {}
  }

  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

// ── Navigate to Activity Search ───────────────────────────────────────────

async function goToActivitySearch(page) {
  // Try clicking nav link first
  const navLinks = [
    'a:has-text("Activity Registration")',
    'a:has-text("Activities")',
    'a:has-text("Programs")',
    'nav a[href*="activity"]',
  ];
  for (const sel of navLinks) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);
        return;
      }
    } catch (_) {}
  }

  // Fallback: direct URL
  const searchUrl = `${CONFIG.baseUrl}/activity/search`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);
}

// ── Fill Search Form ──────────────────────────────────────────────────────

async function fillSearchForm(page) {
  // Keyword
  const keywordSelectors = [
    'input[placeholder*="keyword" i]',
    'input[placeholder*="activity name" i]',
    'input[placeholder*="search" i]',
    'input[name*="keyword" i]',
    'input[id*="keyword" i]',
    '#search-keyword',
    '.keyword-input',
  ];
  let keywordFilled = false;
  for (const sel of keywordSelectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.fill(CONFIG.searchKeyword); keywordFilled = true; break; }
    } catch (_) {}
  }
  if (!keywordFilled) {
    broadcast({ type: 'log', message: 'Warning: could not find keyword search field.' });
  }

  // Age From
  const ageFromSelectors = [
    'input[name*="age_from" i]',
    'input[id*="age_from" i]',
    'input[name*="agefrom" i]',
    'input[placeholder*="age from" i]',
    'input[placeholder*="min age" i]',
    '#ageFrom',
  ];
  for (const sel of ageFromSelectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.triple_click?.(); await el.fill(String(CONFIG.ageFrom)); break; }
    } catch (_) {}
  }

  // Age To
  const ageToSelectors = [
    'input[name*="age_to" i]',
    'input[id*="age_to" i]',
    'input[name*="ageto" i]',
    'input[placeholder*="age to" i]',
    'input[placeholder*="max age" i]',
    '#ageTo',
  ];
  for (const sel of ageToSelectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.fill(String(CONFIG.ageTo)); break; }
    } catch (_) {}
  }

  // Submit search
  const searchBtns = [
    'button:has-text("Search")',
    'input[type="submit"]',
    'button[type="submit"]',
    'a:has-text("Search")',
    '#search-submit',
    '.search-button',
  ];
  for (const sel of searchBtns) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); break; }
    } catch (_) {}
  }

  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

// ── Extract Open Spots ────────────────────────────────────────────────────

async function extractOpenSpots(page) {
  const found = [];

  // Grab the full page text for broad matching
  const pageText = await page.innerText('body').catch(() => '');

  // If "no results" phrase appears, return early
  if (/no (activities|results|programs) found/i.test(pageText)) {
    broadcast({ type: 'log', message: 'Search returned no activities.' });
    return found;
  }

  // Try structured row selectors first
  const rowSelectors = [
    'tr.activity-row',
    '.activity-list-item',
    '.search-result-item',
    '.an-activity-item',
    'table.activity-table tbody tr',
    '.activity-card',
    '[class*="activity-item"]',
    '[class*="search-result"]',
  ];

  let rows = [];
  for (const sel of rowSelectors) {
    rows = await page.$$(sel);
    if (rows.length > 0) break;
  }

  if (rows.length > 0) {
    for (const row of rows) {
      const text = (await row.innerText().catch(() => '')).trim();
      if (!text) continue;

      // Must contain "pickleball" (case-insensitive)
      if (!/pickleball/i.test(text)) continue;

      // Must be open / have spots (not full or waitlist)
      const isOpen =
        /\bopen\b/i.test(text) ||
        /\bavailable\b/i.test(text) ||
        /[1-9]\d*\s*(spot|space|opening)/i.test(text);
      const isFull = /\bfull\b/i.test(text) || /\bwaitlist\b/i.test(text) || /\bwait list\b/i.test(text);

      if (isOpen && !isFull) {
        const nameEl = await row.$('td:first-child, .activity-name, h3, h4, .title, [class*="name"]');
        const name = nameEl
          ? (await nameEl.innerText().catch(() => '')).trim()
          : text.split('\n')[0].trim();

        const spotsEl = await row.$('[class*="spot"], [class*="available"], td:last-child');
        const spotsText = spotsEl ? (await spotsEl.innerText().catch(() => '')).trim() : '';

        found.push({
          name: name || 'Pickleball Activity',
          details: text.replace(/\s+/g, ' ').substring(0, 300),
          spots: spotsText || 'Open',
          foundAt: new Date().toLocaleString('en-CA'),
        });
      }
    }
  } else {
    // Fallback: scan raw page text for open pickleball mentions
    broadcast({ type: 'log', message: 'Using fallback text scan (no structured rows found).' });
    const lines = pageText.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (/pickleball/i.test(lines[i])) {
        const context = lines.slice(Math.max(0, i - 1), i + 4).join(' ');
        const isOpen =
          /\bopen\b/i.test(context) ||
          /\bavailable\b/i.test(context) ||
          /[1-9]\d*\s*(spot|space)/i.test(context);
        const isFull = /\bfull\b/i.test(context) || /\bwaitlist\b/i.test(context);
        if (isOpen && !isFull) {
          found.push({
            name: lines[i],
            details: context.substring(0, 300),
            spots: 'Open (detected)',
            foundAt: new Date().toLocaleString('en-CA'),
          });
        }
      }
    }
  }

  broadcast({ type: 'log', message: `Scan complete — ${found.length} open spot(s) detected.` });
  return found;
}
