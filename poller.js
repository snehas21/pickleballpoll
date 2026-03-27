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
const TARGET_TIME_TO = process.env.TARGET_TIME_TO || null;

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

  const mailOptions = {
    from: process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL,
    subject: `🏓 Pickleball spot(s) available in Richmond Hill!`,
    text: `The following pickleball drop-in session(s) just opened up:\n\n${spotLines}\n\nBook now: ${BASE_URL}/activities/search?query=pickleball\n`,
    html: `
      <h2>🏓 Pickleball spots available!</h2>
      <p>The following drop-in session(s) just opened up:</p>
      <ul>${spots.map(s => `<li><strong>${s.name}</strong><br>${s.date} ${s.time} @ ${s.location}</li>`).join('')}</ul>
      <p><a href="${BASE_URL}/activities/search?query=pickleball">Book now →</a></p>
    `,
  };

  await transporter.sendMail(mailOptions);
  log(`📧 Email alert sent to ${process.env.NOTIFY_EMAIL}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toLocaleString()}] ${msg}`);
}

function isInTargetDay(dateStr) {
  if (TARGET_DAYS.length === 0) return true;
  const day = new Date(dateStr).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  return TARGET_DAYS.includes(day);
}

function isInTargetTime(timeStr) {
  if (!TARGET_TIME_FROM || !TARGET_TIME_TO) return true;
  if (!timeStr) return true;
  // Parse time like "6:00 PM" → compare against TARGET_TIME_FROM/TO (24h)
  const [time, period] = timeStr.split(' ');
  let [hours, minutes] = time.split(':').map(Number);
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  const timeVal = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return timeVal >= TARGET_TIME_FROM && timeVal <= TARGET_TIME_TO;
}

// ─── Core Polling Logic ───────────────────────────────────────────────────────

async function checkAvailability() {
  log('Starting availability check…');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // 1. Go to the site
    await page.goto(`${BASE_URL}/home?onlineSiteId=0&from_original_cui=true`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    log('Loaded home page');

    // 2. Log in
    await login(page);

    // 3. Search for pickleball drop-in sessions
    const spots = await findDropInSpots(page);

    if (spots.length > 0) {
      log(`✅ Found ${spots.length} available spot(s)!`);
      spots.forEach(s => log(`   ${s.name} — ${s.date} ${s.time} @ ${s.location}`));
      await sendAlert(spots);
    } else {
      log('No available pickleball drop-in spots found.');
    }
  } catch (err) {
    log(`❌ Error during check: ${err.message}`);
    // Take a screenshot for debugging
    await page.screenshot({ path: `error-${Date.now()}.png` });
    log('Screenshot saved for debugging.');
  } finally {
    await browser.close();
  }
}

async function login(page) {
  // Look for a sign-in link/button and click it
  const signInLink = page.locator('a, button').filter({ hasText: /sign in|log in|login/i }).first();
  if (await signInLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await signInLink.click();
    await page.waitForLoadState('networkidle');
    log('Clicked Sign In');
  }

  // Fill in username / email
  const usernameField = page.locator('input[type="email"], input[name*="user"], input[id*="user"], input[placeholder*="email" i], input[placeholder*="username" i]').first();
  await usernameField.waitFor({ timeout: 10000 });
  await usernameField.fill(process.env.AC_USERNAME);

  // Fill in password
  const passwordField = page.locator('input[type="password"]').first();
  await passwordField.fill(process.env.AC_PASSWORD);

  // Submit
  const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
  await submitBtn.click();
  await page.waitForLoadState('networkidle');
  log('Logged in successfully');
}

async function findDropInSpots(page) {
  // Navigate to the activities search page
  await page.goto(`${BASE_URL}/activities/search?query=${encodeURIComponent(SEARCH_KEYWORD)}&type=dropin`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  log('Navigated to pickleball drop-in search');

  // Wait for results to load
  await page.waitForTimeout(3000);

  // Try to find activity cards / rows
  const spots = [];

  // Active Communities typically lists activities in cards or table rows
  // We look for items that indicate availability (not "Full", not "Closed")
  const activityItems = await page.locator('[class*="activity"], [class*="program"], [class*="session"], .result-item, .activity-item').all();

  if (activityItems.length === 0) {
    // Fallback: scrape the full page text and look for patterns
    const bodyText = await page.innerText('body');
    return parseBodyTextForSpots(bodyText);
  }

  for (const item of activityItems) {
    const text = await item.innerText().catch(() => '');
    if (!text.toLowerCase().includes('pickleball')) continue;

    const isFull = /full|sold out|no spots|waitlist only/i.test(text);
    const isClosed = /closed|cancelled|not available/i.test(text);
    if (isFull || isClosed) continue;

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
    if (line.toLowerCase().includes('pickleball')) {
      inPickleball = true;
    }
    if (!inPickleball) continue;

    // Reset if we hit a new unrelated section
    if (!line.toLowerCase().includes('pickleball') && /^(yoga|swimming|tennis|soccer|basketball)/i.test(line)) {
      inPickleball = false;
      continue;
    }

    // Look for availability indicators
    const hasAvailability = /\d+\s*(spot|space|opening|available|open)/i.test(line);
    const isFull = /full|sold out|waitlist|no spots/i.test(line);

    if (hasAvailability && !isFull) {
      // Try to grab surrounding context
      const context = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
      const spot = extractSpotInfo(context);
      if (spot) spots.push(spot);
    }
  }

  return spots;
}

function extractSpotInfo(text) {
  // Extract date (e.g. "Mon, Jun 10" or "June 10, 2024" or "2024-06-10")
  const dateMatch = text.match(
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z,\s]*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?/i
  ) || text.match(/\d{4}-\d{2}-\d{2}/);

  // Extract time (e.g. "6:00 PM" or "18:00")
  const timeMatch = text.match(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?/);

  // Extract location
  const locationMatch = text.match(/(?:at|@|location[:\s]+)([A-Z][^\n,]+)/i) ||
    text.match(/(Community Centre|Arena|Park|Gym|Recreation|Centre|Center)/i);

  // Extract name — first line containing "pickleball"
  const nameMatch = text.match(/[^\n]*pickleball[^\n]*/i);

  if (!dateMatch && !timeMatch) return null;

  return {
    name: nameMatch ? nameMatch[0].trim() : 'Pickleball Drop-In',
    date: dateMatch ? dateMatch[0].trim() : 'Date TBD',
    time: timeMatch ? timeMatch[0].trim() : 'Time TBD',
    location: locationMatch ? (locationMatch[1] || locationMatch[0]).trim() : 'Location TBD',
  };
}

// ─── Polling Loop ─────────────────────────────────────────────────────────────

async function validateConfig() {
  const required = ['AC_USERNAME', 'AC_PASSWORD', 'SMTP_USER', 'SMTP_PASS', 'NOTIFY_EMAIL'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error(`\n❌ Missing required environment variables: ${missing.join(', ')}`);
    console.error('   Copy .env.example to .env and fill in your credentials.\n');
    process.exit(1);
  }
}

async function main() {
  await validateConfig();

  log(`🏓 Pickleball Poller started`);
  log(`   Polling every ${process.env.POLL_INTERVAL_MINUTES || 30} minutes`);
  log(`   Watching for: drop-in sessions`);
  if (TARGET_DAYS.length > 0) log(`   Target days: ${TARGET_DAYS.join(', ')}`);
  if (TARGET_TIME_FROM) log(`   Target times: ${TARGET_TIME_FROM} – ${TARGET_TIME_TO}`);
  log('');

  // Run immediately on start, then on interval
  await checkAvailability();

  setInterval(async () => {
    await checkAvailability();
  }, POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
