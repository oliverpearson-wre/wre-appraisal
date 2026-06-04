#!/usr/bin/env node
/**
 * warm-mbie.js — Fetch fresh MBIE data and write to data/mbie-waikato.json
 * Run manually when you want to refresh: node scripts/warm-mbie.js
 * Or set up a monthly cron.
 *
 * Usage:
 *   node scripts/warm-mbie.js              # Waikato TAs only
 *   node scripts/warm-mbie.js --all        # All NZ TAs
 *   node scripts/warm-mbie.js --dry-run    # Show what would be fetched
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const MBIE_KEY = process.env.MBIE_KEY || 'fe60f32fecf24e339f99e7d2b6ce0f82';
const BASE     = 'api.business.govt.nz';
const BASE_PATH = '/gateway/tenancy-services/market-rent/v2';
const OUT_FILE  = path.join(__dirname, '../data/mbie-waikato.json');

const WAIKATO_TAS = {
  'Hamilton City':              '107',
  'Waikato District':           '110',
  'Waipa District':             '111',
  'Matamata-Piako District':    '112',
  'Thames-Coromandel District': '114',
  'Hauraki District':           '108',
  'Otorohanga District':        '115',
  'South Waikato District':     '116',
  'Taupo District':             '118',
  'Waitomo District':           '119',
};

const BEDROOMS = ['1', '2', '3', '4', '5+'];

const DRY_RUN = process.argv.includes('--dry-run');

function periodEnding() {
  const d = new Date();
  d.setMonth(d.getMonth() - 2);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(path, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: BASE, path, method: 'GET',
      headers: { 'Accept': 'application/json', 'Ocp-Apim-Subscription-Key': MBIE_KEY }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function fetchStats(taCode, bedrooms) {
  const period = periodEnding();
  const qs = new URLSearchParams({
    'period-ending':   period,
    'num-months':      '12',
    'area-definition': 'territorial-authority-2019',
    'area-codes':      taCode,
    'num-bedrooms':    bedrooms,
  }).toString();

  const url = `${BASE_PATH}/statistics?${qs}`;

  if (DRY_RUN) {
    console.log('  [dry-run]', url);
    return null;
  }

  // Retry once on error
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await httpsGet(url);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const items = Array.isArray(data) ? data : (data.items || data.data || []);
        return items;
      }
      if (r.status >= 400 && r.status < 500) {
        console.warn(`  HTTP ${r.status} — skipping`);
        return null;
      }
      console.warn(`  HTTP ${r.status} attempt ${attempt} — retrying...`);
    } catch(e) {
      console.warn(`  Error attempt ${attempt}: ${e.message}`);
      if (attempt === 1) await sleep(5000);
    }
  }
  return null;
}

async function main() {
  console.log('MBIE Waikato warm script');
  console.log('Period ending:', periodEnding());
  console.log('Dry run:', DRY_RUN);
  console.log('');

  // Load existing cache to preserve data we can't re-fetch
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch(e) {}

  const period = periodEnding();
  cache._meta = {
    source: 'MBIE Market Rent API - api.business.govt.nz',
    area_definition: 'territorial-authority-2019',
    generated: new Date().toISOString().split('T')[0],
    period_ending: period,
    num_months: 12,
    note: 'Updated by scripts/warm-mbie.js'
  };

  let fetched = 0, suppressed = 0, errors = 0;

  for (const [taName, taCode] of Object.entries(WAIKATO_TAS)) {
    console.log(`\n${taName} (${taCode})`);
    if (!cache[taName]) cache[taName] = { [taCode]: {} };
    if (!cache[taName][taCode]) cache[taName][taCode] = {};

    for (const beds of BEDROOMS) {
      process.stdout.write(`  ${beds}bd ... `);
      const items = await fetchStats(taCode, beds);

      if (items === null) {
        if (!DRY_RUN) errors++;
        process.stdout.write('skip\n');
        continue;
      }
      if (items.length === 0) {
        suppressed++;
        process.stdout.write('suppressed (<5 bonds)\n');
        continue;
      }

      // Weighted blend by nCurr
      const rows  = items.filter(r => r.med != null && r.nCurr > 0);
      if (!rows.length) { suppressed++; process.stdout.write('all null\n'); continue; }

      const totalW = rows.reduce((s, r) => s + r.nCurr, 0);
      const wMed   = Math.round(rows.reduce((s, r) => s + r.med * r.nCurr, 0) / totalW / 5) * 5;
      const wLq    = Math.round(rows.reduce((s, r) => s + r.lq  * r.nCurr, 0) / totalW / 5) * 5;
      const wUq    = Math.round(rows.reduce((s, r) => s + r.uq  * r.nCurr, 0) / totalW / 5) * 5;

      // Growth from oldest to newest period in results
      const sorted  = [...rows].sort((a, b) => (a.period||'').localeCompare(b.period||''));
      const newest  = sorted[sorted.length - 1];
      const oldest  = sorted[0];
      const growth  = oldest.med > 0
        ? parseFloat(((newest.med - oldest.med) / oldest.med * 100).toFixed(1))
        : 4.8;

      cache[taName][taCode][beds] = { lq: wLq, med: wMed, uq: wUq, nCurr: totalW, growth };
      fetched++;
      process.stdout.write(`$${wLq}/$${wMed}/$${wUq} (n=${totalW})\n`);

      // Politeness delay between real calls
      await sleep(250);
    }

    // Atomic write after each TA so a crash doesn't lose all work
    if (!DRY_RUN) {
      const tmp = OUT_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
      fs.renameSync(tmp, OUT_FILE);
    }
  }

  console.log(`\nDone. fetched=${fetched} suppressed=${suppressed} errors=${errors}`);
  if (!DRY_RUN) console.log(`Written to ${OUT_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
