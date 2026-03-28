require('dotenv').config();
const fs           = require('fs');
const path         = require('path');
const { chromium } = require('playwright');
const nodemailer   = require('nodemailer');
const history      = require('./history');

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL         = 'https://anc.ca.apm.activecommunities.com/richmondhill';
const SEARCH_KEYWORD   = 'pickleball';
const POLL_INTERVAL_MS = (parseInt(process.env.POLL_INTERVAL_MINUTES) || 30) * 60 * 1000;
const SCREENSHOTS_DIR  = path.join(__dirname, 'public', 'screenshots');

const TARGET_DAYS = process.env.TARGET_DAYS
  ? process.env.TARGET_DAYS.split(',').map(d => d.trim().toLowerCase())
  : [];

const TARGET_TIME_FROM = process.env.TARGET_TIME_FROM || null;
const TARGET_TIME_TO   = process.env.TARGET_TIME_TO   || null;

const AGE_MIN = 40;
const AGE_MAX = 50;

// Ensure screenshots directory exists
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ─── Logging ──────────────────────────────────────────────────────────────────

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

// ─── Screenshot streaming ─────────────────────────────────────────────────────

// Latest screenshot buffer — read by /api/screenshot
let latestScreenshot = null;
let latestScreenshotStep = null;

async function snap(page, stepLabel) {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
    latestScreenshot     = buf;
    latestScreenshotStep = stepLabel;
    log(`📷 ${stepLabel}`);
    // Notify screenshot listeners
    screenshotListeners.forEach(fn => fn(buf, stepLabel));
  } catch {
    // Non-fatal — don't interrupt the poll if screenshot fails
  }
}

const screenshotListeners = [];

function onScreenshot(fn) {
  screenshotListeners.push(fn);
  return () => {
    const i = screenshotListeners.indexOf(fn);
    if (i !== -1) screenshotListeners.splice(i, 1);
  };
}

function getLatestScreenshot() {
  return { buf: latestScreenshot, step: latestScreenshotStep };
}

function clearScreenshot() {
  latestScreenshot     = null;
  latestScreenshotStep = null;
}

// ─── Email ────────────────────────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendAlert(spots) {
  const spotLines = spots.map(s => `• ${s.name} — ${s.date} ${s.time} @ ${s.location}`).join('\n');
  await transporter.sendMail({
    from:    process.env.SMTP_USER,
    to:      process.env.NOTIFY_EMAIL,
    subject: `🏓 Pickleball drop-in spot(s) available in Richmond Hill!`,
    text:    `The following pickleball drop-in session(s) just opened up (ages ${AGE_MIN}–${AGE_MAX}):\n\n${spotLines}\n\nBook now: ${BASE_URL}/activities/search?query=pickleball\n`,
    html:    `<h2>🏓 Pickleball spots available! (Ages ${AGE_MIN}–${AGE_MAX})</h2>
              <p>The following drop-in session(s) just opened up:</p>
              <ul>${spots.map(s => `<li><strong>${s.name}</strong><br>${s.date} ${s.time} @ ${s.location}</li>`).join('')}</ul>
              <p><a href="${BASE_URL}/activities/search?query=pickleball">Book now →</a></p>`,
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

function isAgeEligible(text) {
  if (!text) return true;
  if (/senior|55\+|60\+|65\+|ages?\s*5[5-9]|ages?\s*6\d/i.test(text)) return false;
  if (/youth|junior|child|teen|ages?\s*[0-1]?\d\s*[-–]\s*[1-3]\d/i.test(text)) return false;
  const rangeMatch = text.match(/ages?\s*(\d+)\s*[-–to]+\s*(\d+)/i);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1]), hi = parseInt(rangeMatch[2]);
    return lo <= AGE_MAX && hi >= AGE_MIN;
  }
  const minAgeMatch = text.match(/ages?\s*(\d+)\s*\+/i) || text.match(/(\d+)\s*\+\s*years?/i);
  if (minAgeMatch) return parseInt(minAgeMatch[1]) <= AGE_MAX;
  return true;
}

// ─── Core Polling Logic ───────────────────────────────────────────────────────

async function checkAvailability(triggeredBy = 'schedule') {
  log('Starting availability check…');

  const run = history.startRun();
  run.triggeredBy = triggeredBy;

  let browser = null;
  let page    = null;

  try {
    // ── Launch browser ──
    log('🌐 Launching browser…');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport:  { width: 1280, height: 800 },
    });
    page = await context.newPage();

    // ── Navigate to site ──
    log('🔗 Navigating to Active Communities (Richmond Hill)…');
    await page.goto(`${BASE_URL}/home?onlineSiteId=0&from_original_cui=true`, {
      waitUntil: 'networkidle',
      timeout:   30000,
    });
    await snap(page, 'Home page loaded');

    // ── Log in ──
    await login(page);
    await snap(page, 'Logged in');

    // ── Search ──
    const spots = await findDropInSpots(page);
    await snap(page, 'Search results loaded');
    run.spotsFound = spots;

    if (spots.length > 0) {
      log(`✅ Found ${spots.length} available spot(s) for ages ${AGE_MIN}–${AGE_MAX}!`);
      spots.forEach(s => log(`   ↳ ${s.name} — ${s.date} ${s.time} @ ${s.location}`));
      await sendAlert(spots);
      run.emailSent = true;
      run.status    = 'success';
    } else {
      log(`No available pickleball drop-in spots found for ages ${AGE_MIN}–${AGE_MAX}.`);
      run.status = 'no_spots';
    }

    history.finishRun(run);
    return spots;

  } catch (err) {
    log(`❌ Error: ${err.message}`);
    run.status = 'error';
    run.error  = err.message;

    // Safe screenshot on error — only if page exists
    if (page) {
      try {
        await snap(page, `Error: ${err.message.slice(0, 60)}`);
      } catch { /* ignore */ }
    }

    history.finishRun(run);
    throw err;

  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    log('✔ Browser closed.');
  }
}

async function login(page) {
  log('🔑 Looking for Sign In button…');
  const signInLink = page.locator('a, button').filter({ hasText: /sign in|log in|login/i }).first();
  if (await signInLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await signInLink.click();
    await page.waitForLoadState('networkidle');
    log('🔑 Clicked Sign In — waiting for login form…');
    await snap(page, 'Sign-in page');
  }

  log('🔑 Filling in username…');
  const usernameField = page
    .locator('input[type="email"], input[name*="user"], input[id*="user"], input[placeholder*="email" i], input[placeholder*="username" i]')
    .first();
  await usernameField.waitFor({ timeout: 10000 });
  await usernameField.fill(process.env.AC_USERNAME);

  log('🔑 Filling in password…');
  const passwordField = page.locator('input[type="password"]').first();
  await passwordField.fill(process.env.AC_PASSWORD);
  await snap(page, 'Login form filled');

  log('🔑 Submitting login…');
  const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
  await submitBtn.click();
  await page.waitForLoadState('networkidle');
  log('✔ Login submitted — checking result…');
}

async function findDropInSpots(page) {
  log('🔍 Searching for pickleball drop-in sessions…');
  await page.goto(
    `${BASE_URL}/activities/search?query=${encodeURIComponent(SEARCH_KEYWORD)}&type=dropin`,
    { waitUntil: 'networkidle', timeout: 30000 }
  );
  await snap(page, 'Search results page');
  log('⏳ Waiting for results to render…');
  await page.waitForTimeout(3000);
  await snap(page, 'Results fully loaded');

  const spots        = [];
  const activityItems = await page
    .locator('[class*="activity"], [class*="program"], [class*="session"], .result-item, .activity-item')
    .all();

  log(`📋 Found ${activityItems.length} activity item(s) on page`);

  if (activityItems.length === 0) {
    log('⚠ No structured items found — falling back to full-page text scan');
    const bodyText = await page.innerText('body');
    return parseBodyTextForSpots(bodyText);
  }

  for (const item of activityItems) {
    const text = await item.innerText().catch(() => '');
    if (!text.toLowerCase().includes('pickleball')) continue;
    if (/full|sold out|no spots|waitlist only/i.test(text)) {
      log(`   ⛔ Full/waitlist: ${text.split('\n')[0].trim().slice(0, 60)}`);
      continue;
    }
    if (/closed|cancelled|not available/i.test(text)) continue;
    if (!isAgeEligible(text)) {
      log(`   🚫 Age restriction: ${text.split('\n')[0].trim().slice(0, 60)}`);
      continue;
    }

    const spot = extractSpotInfo(text);
    if (!spot) continue;
    if (!isInTargetDay(spot.date)) continue;
    if (!isInTargetTime(spot.time)) continue;

    log(`   ✅ Eligible: ${spot.name} — ${spot.date} ${spot.time}`);
    spots.push(spot);
  }

  return spots;
}

function parseBodyTextForSpots(bodyText) {
  const spots = [];
  const lines  = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
  let inPickleball = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.toLowerCase().includes('pickleball')) inPickleball = true;
    if (!inPickleball) continue;
    if (!line.toLowerCase().includes('pickleball') && /^(yoga|swimming|tennis|soccer|basketball)/i.test(line)) {
      inPickleball = false; continue;
    }
    const hasAvailability = /\d+\s*(spot|space|opening|available|open)/i.test(line);
    const isFull          = /full|sold out|waitlist|no spots/i.test(line);
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
  const timeMatch     = text.match(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?/);
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
  checkAvailability('schedule');
  return setInterval(() => checkAvailability('schedule'), POLL_INTERVAL_MS);
}

module.exports = { checkAvailability, onLog, onScreenshot, getLatestScreenshot, clearScreenshot, startPollingLoop, validateConfig };

if (require.main === module) {
  validateConfig();
  startPollingLoop();
}
