require('dotenv').config();
const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL = 'https://anc.ca.apm.activecommunities.com/richmondhill';
const SEARCH_KEYWORD = 'pickleball';
const POLL_INTERVAL_MS = (parseInt(process.env.POLL_INTERVAL_MINUTES) || 30) * 60 * 1000;

const TARGET_DAYS = process.env.TARGET_DAYS
  ? process.env.TARGET_DAYS.split(',').map(d => d.trim().toLowerCase())
  : [];

const TARGET_TIME_FROM = process.env.TARGET_TIME_FROM || null;
const TARGET_TIME_TO   = process.env.TARGET_TIME_TO   || null;

// Age filter: drop-in sessions open to someone aged 40–50
const AGE_MIN = 40;
const AGE_MAX = 50;

// ─── Logging (supports live streaming to web UI) ──────────────────────────────

const logListeners = [];

function log(msg) {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  logListeners.forEach(fn => fn(line));
}

function onLog(fn) {
  logListeners.push(fn);
  return () => {
    const i = logListeners.indexOf(fn);
    if (i !== -1) logListeners.splice(i, 1);
  };
}

// ─── Email ────────────────────────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendAlert(spots) {
  const spotLines = spots
    .map(s => `• ${s.name} — ${s.date} ${s.time} @ ${s.location}`)
    .join('\n');

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL,
    subject: `🏓 Pickleball drop-in spot(s) available in Richmond Hill!`,
    text: `The following pickleball drop-in session(s) just opened up (ages ${AGE_MIN}–${AGE_MAX}):\n\n${spotLines}\n\nBook now: ${BASE_URL}/activities/search?query=pickleball\n`,
    html: `
      <h2>🏓 Pickleball spots available! (Ages ${AGE_MIN}–${AGE_MAX})</h2>
      <p>The following drop-in session(s) just opened up:</p>
      <ul>${spots.map(s => `<li><strong>${s.name}</strong><br>${s.date} ${s.time} @ ${s.location}</li>`).join('')}</ul>
      <p><a href="${BASE_URL}/activities/search?query=pickleball">Book now →</a></p>
    `,
  });
  log(`📧 Email alert sent to ${process.env.NOTIFY_EMAIL}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isInTargetDay(dateStr) {
  if (TARGET_DAYS.length === 0) return true;
  const day = new Date(dateStr).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  return TARGET_DAYS.includes(day);
}

function isInTargetTime(timeStr) {
  if (!TARGET_TIME_FROM || !TARGET_TIME_TO || !timeStr) return true;
  const [time, period] = timeStr.split(' ');
  let [hours, minutes] = time.split(':').map(Number);
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  const val = `${String(hours).padStart(2, '0')}:${String(minutes || 0).padStart(2, '0')}`;
  return val >= TARGET_TIME_FROM && val <= TARGET_TIME_TO;
}

/**
 * Returns true if this activity is open to someone aged 40–50.
 * Handles patterns like:
 *   "Ages 18+"  "40-60 years"  "Adult (18+)"  "Senior (55+)"  "Youth (12-17)"
 */
function isAgeEligible(text) {
  if (!text) return true;

  // Explicit senior-only markers (55+, 60+, 65+)
  if (/senior|55\+|60\+|65\+|ages?\s*5[5-9]|ages?\s*6\d/i.test(text)) return false;

  // Explicit youth/junior only
  if (/youth|junior|child|teen|ages?\s*[0-1]?\d\s*[-–]\s*[1-3]\d/i.test(text)) return false;

  // Explicit range like "40-60" or "35-55" — check overlap with 40–50
  const rangeMatch = text.match(/ages?\s*(\d+)\s*[-–to]+\s*(\d+)/i);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1]);
    const hi = parseInt(rangeMatch[2]);
    // Eligible if ranges overlap: lo <= AGE_MAX AND hi >= AGE_MIN
    return lo <= AGE_MAX && hi >= AGE_MIN;
  }

  // Minimum age only, e.g. "18+" or "Ages 18+"
  const minAgeMatch = text.match(/ages?\s*(\d+)\s*\+/i) || text.match(/(\d+)\s*\+\s*years?/i);
  if (minAgeMatch) {
    const minAge = parseInt(minAgeMatch[1]);
    return minAge <= AGE_MAX; // if min age ≤ 50, someone aged 40–50 qualifies
  }

  // No age restriction found — assume open to all
  return true;
}

// ─── Core Polling Logic ───────────────────────────────────────────────────────

async function checkAvailability() {
  log('Starting availability check…');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto(`${BASE_URL}/home?onlineSiteId=0&from_original_cui=true`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    log('Loaded home page');

    await login(page);

    const spots = await findDropInSpots(page);

    if (spots.length > 0) {
      log(`✅ Found ${spots.length} available spot(s) for ages ${AGE_MIN}–${AGE_MAX}!`);
      spots.forEach(s => log(`   ${s.name} — ${s.date} ${s.time} @ ${s.location}`));
      await sendAlert(spots);
    } else {
      log(`No available pickleball drop-in spots found for ages ${AGE_MIN}–${AGE_MAX}.`);
    }

    return spots;
  } catch (err) {
    log(`❌ Error during check: ${err.message}`);
    await page.screenshot({ path: `error-${Date.now()}.png` });
    log('Screenshot saved for debugging.');
    throw err;
  } finally {
    await browser.close();
  }
}

async function login(page) {
  const signInLink = page.locator('a, button').filter({ hasText: /sign in|log in|login/i }).first();
  if (await signInLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await signInLink.click();
    await page.waitForLoadState('networkidle');
    log('Clicked Sign In');
  }

  const usernameField = page
    .locator('input[type="email"], input[name*="user"], input[id*="user"], input[placeholder*="email" i], input[placeholder*="username" i]')
    .first();
  await usernameField.waitFor({ timeout: 10000 });
  await usernameField.fill(process.env.AC_USERNAME);

  const passwordField = page.locator('input[type="password"]').first();
  await passwordField.fill(process.env.AC_PASSWORD);

  const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
  await submitBtn.click();
  await page.waitForLoadState('networkidle');
  log('Logged in successfully');
}

async function findDropInSpots(page) {
  await page.goto(
    `${BASE_URL}/activities/search?query=${encodeURIComponent(SEARCH_KEYWORD)}&type=dropin`,
    { waitUntil: 'networkidle', timeout: 30000 }
  );
  log('Navigated to pickleball drop-in search');
  await page.waitForTimeout(3000);

  const spots = [];
  const activityItems = await page
    .locator('[class*="activity"], [class*="program"], [class*="session"], .result-item, .activity-item')
    .all();

  if (activityItems.length === 0) {
    const bodyText = await page.innerText('body');
    return parseBodyTextForSpots(bodyText);
  }

  for (const item of activityItems) {
    const text = await item.innerText().catch(() => '');
    if (!text.toLowerCase().includes('pickleball')) continue;

    if (/full|sold out|no spots|waitlist only/i.test(text)) continue;
    if (/closed|cancelled|not available/i.test(text)) continue;
    if (!isAgeEligible(text)) {
      log(`   Skipped (age restriction): ${text.split('\n')[0].trim()}`);
      continue;
    }

    const spot = extractSpotInfo(text);
    if (!spot) continue;
    if (!isInTargetDay(spot.date)) continue;
    if (!isInTargetTime(spot.time)) continue;

    spots.push(spot);
  }

  return spots;
}

function parseBodyTextForSpots(bodyText) {
  const spots = [];
  const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
  let inPickleball = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.toLowerCase().includes('pickleball')) inPickleball = true;
    if (!inPickleball) continue;
    if (!line.toLowerCase().includes('pickleball') && /^(yoga|swimming|tennis|soccer|basketball)/i.test(line)) {
      inPickleball = false;
      continue;
    }

    const hasAvailability = /\d+\s*(spot|space|opening|available|open)/i.test(line);
    const isFull = /full|sold out|waitlist|no spots/i.test(line);
    if (!hasAvailability || isFull) continue;

    const context = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
    if (!isAgeEligible(context)) continue;

    const spot = extractSpotInfo(context);
    if (spot) spots.push(spot);
  }

  return spots;
}

function extractSpotInfo(text) {
  const dateMatch =
    text.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z,\s]*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?/i) ||
    text.match(/\d{4}-\d{2}-\d{2}/);
  const timeMatch    = text.match(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?/);
  const locationMatch =
    text.match(/(?:at|@|location[:\s]+)([A-Z][^\n,]+)/i) ||
    text.match(/(Community Centre|Arena|Park|Gym|Recreation|Centre|Center)/i);
  const nameMatch = text.match(/[^\n]*pickleball[^\n]*/i);

  if (!dateMatch && !timeMatch) return null;

  return {
    name:     nameMatch     ? nameMatch[0].trim()                           : 'Pickleball Drop-In',
    date:     dateMatch     ? dateMatch[0].trim()                           : 'Date TBD',
    time:     timeMatch     ? timeMatch[0].trim()                           : 'Time TBD',
    location: locationMatch ? (locationMatch[1] || locationMatch[0]).trim() : 'Location TBD',
  };
}

// ─── Polling Loop ─────────────────────────────────────────────────────────────

function validateConfig() {
  const required = ['AC_USERNAME', 'AC_PASSWORD', 'SMTP_USER', 'SMTP_PASS', 'NOTIFY_EMAIL'];
  const missing  = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error(`\n❌ Missing required environment variables: ${missing.join(', ')}`);
    console.error('   Copy .env.example to .env and fill in your credentials.\n');
    process.exit(1);
  }
}

function startPollingLoop() {
  log(`🏓 Pickleball Poller started — checking every ${process.env.POLL_INTERVAL_MINUTES || 30} min`);
  log(`   Age filter: ${AGE_MIN}–${AGE_MAX} years`);
  checkAvailability();
  return setInterval(checkAvailability, POLL_INTERVAL_MS);
}

module.exports = { checkAvailability, onLog, startPollingLoop, validateConfig };

// Run directly if invoked as main script
if (require.main === module) {
  validateConfig();
  startPollingLoop();
}
