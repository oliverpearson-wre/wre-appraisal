#!/usr/bin/env node
/**
 * warm-mbie.js — Fetch MBIE market rent data and write to data/mbie-waikato.json
 *
 * Strategy (matches the brief's estimate ladder):
 *   Pass 1: SAU2019 — one call returns ALL ~1,611 suburb-level areas nationwide
 *   Pass 2: IMR2017 — one call returns ALL ~301 clustered suburb groups
 *   Pass 3: TA2019  — one call per TA (city-level fallback)
 *
 * Usage:
 *   node scripts/warm-mbie.js           # all three passes
 *   node scripts/warm-mbie.js --dry-run # show what would be fetched
 *   node scripts/warm-mbie.js --ta-only # skip SAU/IMR (fast test)
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const MBIE_KEY = process.env.MBIE_KEY || 'fe60f32fecf24e339f99e7d2b6ce0f82';
const BASE     = 'api.business.govt.nz';
const BASE_PATH = '/gateway/tenancy-services/market-rent/v2';
const OUT_FILE  = path.join(__dirname, '../data/mbie-waikato.json');

const DRY_RUN  = process.argv.includes('--dry-run');
const TA_ONLY  = process.argv.includes('--ta-only');

// Waikato TA codes
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

// Keywords to identify Waikato suburbs in SAU/IMR results
const WAIKATO_KEYWORDS = [
  'hamilton', 'waikato', 'cambridge', 'te awamutu', 'huntly', 'raglan',
  'morrinsville', 'matamata', 'te kuiti', 'otorohanga', 'taupo', 'tokoroa',
  'paeroa', 'thames', 'coromandel', 'whitianga', 'tairua', 'whangamata',
];

function isWaikato(label) {
  if (!label) return false;
  const l = label.toLowerCase();
  return WAIKATO_KEYWORDS.some(k => l.includes(k));
}

function periodEnding() {
  const d = new Date(); d.setMonth(d.getMonth() - 2);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(p, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: BASE, path: p, method: 'GET',
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

async function fetchSlice(areaDefinition, extraParams = {}) {
  const qs = new URLSearchParams({
    'period-ending':   periodEnding(),
    'num-months':      '12',
    'area-definition': areaDefinition,
    ...extraParams,
  }).toString();

  const url = `${BASE_PATH}/statistics?${qs}`;
  if (DRY_RUN) { console.log('  [dry-run]', url); return []; }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`  Fetching ${areaDefinition}... (may take up to 2 min)`);
      const r = await httpsGet(url);
      if (r.status === 200) {
        const data  = JSON.parse(r.body);
        const items = Array.isArray(data) ? data : (data.items || data.data || []);
        console.log(`  Got ${items.length} rows`);
        return items;
      }
      console.warn(`  HTTP ${r.status}: ${r.body.slice(0, 200)}`);
      if (r.status >= 400 && r.status < 500) return [];
    } catch(e) {
      console.warn(`  Error attempt ${attempt}: ${e.message}`);
      if (attempt === 1) await sleep(5000);
    }
  }
  return [];
}

// Blend an array of rows into { lq, med, uq, nCurr, growth }
function blendRows(rows) {
  const valid = rows.filter(r => r.med != null && r.nCurr > 0);
  if (!valid.length) return null;
  const totalW = valid.reduce((s, r) => s + r.nCurr, 0);
  const wMed   = Math.round(valid.reduce((s, r) => s + r.med * r.nCurr, 0) / totalW / 5) * 5;
  const wLq    = Math.round(valid.reduce((s, r) => s + r.lq  * r.nCurr, 0) / totalW / 5) * 5;
  const wUq    = Math.round(valid.reduce((s, r) => s + r.uq  * r.nCurr, 0) / totalW / 5) * 5;
  // brr = bond renewal rate (% change) — MBIE's own growth metric, null if unavailable
  const brrRows = valid.filter(r => r.brr != null);
  const growth = brrRows.length
    ? parseFloat((brrRows.reduce((s, r) => s + r.brr * r.nCurr, 0) / brrRows.reduce((s,r) => s+r.nCurr, 0)).toFixed(1))
    : null;
  return { lq: wLq, med: wMed, uq: wUq, nCurr: totalW, growth };
}

// Group rows by area label and nB (bedrooms)
function groupByAreaAndBeds(items) {
  const result = {};
  for (const row of items) {
    const area = row.area || row.areaLabel || row.label || 'Unknown';
    const beds = String(row.nB || row.numBedrooms || row.bedrooms || 'all');
    if (!result[area]) result[area] = {};
    if (!result[area][beds]) result[area][beds] = [];
    result[area][beds].push(row);
  }
  return result;
}

function atomicWrite(obj) {
  const tmp = OUT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, OUT_FILE);
}

async function main() {
  console.log('MBIE warm script — suburb + city level');
  console.log('Period ending:', periodEnding());
  console.log('Dry run:', DRY_RUN);
  console.log('');

  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch(e) {}

  cache._meta = {
    source:      'MBIE Market Rent API — api.business.govt.nz',
    generated:   new Date().toISOString().split('T')[0],
    period:      periodEnding(),
    note:        'Run scripts/warm-mbie.js to refresh',
  };

  // ── PASS 1: SAU2019 (suburb level) — fetch per dwelling type ──
  if (!TA_ONLY) {
    console.log('=== Pass 1: SAU2019 (suburb level) ===');
    cache.SAU2019 = cache.SAU2019 || {};

    for (const dwelling of ['House', 'Flat', 'Apartment', null]) {
      const label = dwelling || 'all-dwellings';
      console.log(`\n  Dwelling: ${label}`);
      const extra = dwelling ? { 'dwelling-type': dwelling } : {};
      const items = await fetchSlice('SAU2019', extra);
      const grouped = groupByAreaAndBeds(items);
      let count = 0;

      for (const [area, bedGroups] of Object.entries(grouped)) {
        if (!isWaikato(area)) continue;
        if (!cache.SAU2019[area]) cache.SAU2019[area] = {};
        for (const [beds, rows] of Object.entries(bedGroups)) {
          const blended = blendRows(rows);
          if (blended) {
            const key = dwelling ? `${dwelling}:${beds}` : beds;
            cache.SAU2019[area][key] = blended;
            count++;
          }
        }
      }
      console.log(`  Stored ${count} Waikato SAU entries for ${label}`);
      atomicWrite(cache);
      await sleep(500);
    }
  }

  // ── PASS 2: IMR2017 (suburb clusters) — fetch per dwelling type ──
  if (!TA_ONLY) {
    console.log('\n=== Pass 2: IMR2017 (suburb clusters) ===');
    cache.IMR2017 = cache.IMR2017 || {};

    for (const dwelling of ['House', 'Flat', 'Apartment', null]) {
      const label = dwelling || 'all-dwellings';
      const extra = dwelling ? { 'dwelling-type': dwelling } : {};
      const items = await fetchSlice('IMR2017', extra);
      const grouped = groupByAreaAndBeds(items);
      let count = 0;

      for (const [area, bedGroups] of Object.entries(grouped)) {
        if (!isWaikato(area)) continue;
        if (!cache.IMR2017[area]) cache.IMR2017[area] = {};
        for (const [beds, rows] of Object.entries(bedGroups)) {
          const blended = blendRows(rows);
          if (blended) {
            const key = dwelling ? `${dwelling}:${beds}` : beds;
            cache.IMR2017[area][key] = blended;
            count++;
          }
        }
      }
      console.log(`  IMR ${label}: ${count} entries`);
      atomicWrite(cache);
      await sleep(500);
    }
  }

  // ── PASS 3: TA2019 (city level fallback) ──
  console.log('\n=== Pass 3: TA2019 (city level) ===');
  cache.TA2019 = cache.TA2019 || {};

  for (const [taName, taCode] of Object.entries(WAIKATO_TAS)) {
    console.log(`\n${taName} (${taCode})`);
    cache.TA2019[taName] = cache.TA2019[taName] || {};

    const items   = await fetchSlice('territorial-authority-2019', { 'area-codes': taCode });
    const grouped = groupByAreaAndBeds(items);
    let count = 0;

    for (const [area, bedGroups] of Object.entries(grouped)) {
      for (const [beds, rows] of Object.entries(bedGroups)) {
        const blended = blendRows(rows);
        if (blended) {
          if (!cache.TA2019[taName][beds]) cache.TA2019[taName][beds] = {};
          cache.TA2019[taName][beds] = blended;
          console.log(`  ${beds}bd: $${blended.lq}/$${blended.med}/$${blended.uq} (n=${blended.nCurr})`);
          count++;
        }
      }
    }
    if (!count) console.log('  All suppressed');
    atomicWrite(cache);
    await sleep(250);
  }

  console.log('\nDone. Written to', OUT_FILE);
}

main().catch(e => { console.error(e); process.exit(1); });
