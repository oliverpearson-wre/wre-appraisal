const https = require('https');
const fs    = require('fs');
const path  = require('path');

const MBIE_KEY = 'fe60f32fecf24e339f99e7d2b6ce0f82';
const BASE     = 'api.business.govt.nz';
const OUT_FILE = path.join(__dirname, '../data/mbie-waikato.json');

const WAIKATO_TAS = {
  'Hamilton City':'107','Waikato District':'110','Waipa District':'111',
  'Matamata-Piako District':'112','Thames-Coromandel District':'114',
};

function httpsGet(p) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: BASE, path: p, method: 'GET',
      headers: { 'Accept': 'application/json', 'Ocp-Apim-Subscription-Key': MBIE_KEY }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(240000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function periodEnding() {
  const d = new Date(); d.setMonth(d.getMonth() - 2);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function blendRows(rows) {
  const valid = rows.filter(r => r.med != null && r.nCurr > 0);
  if (!valid.length) return null;
  const totalW = valid.reduce((s, r) => s + r.nCurr, 0);
  const wMed = Math.round(valid.reduce((s, r) => s + r.med * r.nCurr, 0) / totalW / 5) * 5;
  const wLq  = Math.round(valid.reduce((s, r) => s + r.lq  * r.nCurr, 0) / totalW / 5) * 5;
  const wUq  = Math.round(valid.reduce((s, r) => s + r.uq  * r.nCurr, 0) / totalW / 5) * 5;
  const brrRows = valid.filter(r => r.brr != null);
  const growth = brrRows.length
    ? parseFloat((brrRows.reduce((s,r) => s + r.brr * r.nCurr, 0) / brrRows.reduce((s,r) => s+r.nCurr,0)).toFixed(1))
    : null;
  return { lq: wLq, med: wMed, uq: wUq, nCurr: totalW, growth };
}

function groupByAreaAndBeds(items) {
  const result = {};
  for (const row of items) {
    const area = row.area || row.areaLabel || 'Unknown';
    const beds = String(row.nB || 'all');
    if (!result[area]) result[area] = {};
    if (!result[area][beds]) result[area][beds] = [];
    result[area][beds].push(row);
  }
  return result;
}

const WAIKATO_KEYWORDS = ['hamilton','waikato','cambridge','te awamutu','huntly',
  'raglan','morrinsville','matamata','te kuiti','otorohanga','taupo','tokoroa',
  'paeroa','thames','coromandel','whitianga','tairua','whangamata'];

function isWaikato(label) {
  const l = (label||'').toLowerCase();
  return WAIKATO_KEYWORDS.some(k => l.includes(k));
}

async function fetchSlice(areaDefinition, dwelling) {
  const params = new URLSearchParams({
    'period-ending': periodEnding(), 'num-months': '12',
    'area-definition': areaDefinition,
  });
  if (dwelling) params.set('dwelling-type', dwelling);
  const r = await httpsGet(`/gateway/tenancy-services/market-rent/v2/statistics?${params}`);
  if (r.status !== 200) return [];
  const data = JSON.parse(r.body);
  return Array.isArray(data) ? data : (data.items || data.data || []);
}

module.exports = async function(req, res) {
  // Only allow GET, and protect with a secret
  const secret = req.query?.secret || req.headers?.['x-warm-secret'];
  if (secret !== 'wre-warm-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Content-Type', 'application/json');

  try {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch(e) {}

    cache._meta = {
      source: 'MBIE Market Rent API',
      generated: new Date().toISOString().split('T')[0],
      period: periodEnding(),
    };
    cache.SAU2019 = cache.SAU2019 || {};
    cache.IMR2017 = cache.IMR2017 || {};
    cache.TA2019  = cache.TA2019  || {};

    const results = { SAU2019: 0, IMR2017: 0, TA2019: 0 };

    // Pass 1 & 2: SAU2019 + IMR2017 (one call per dwelling returns all areas)
    for (const defn of ['SAU2019', 'IMR2017']) {
      for (const dwelling of ['House', 'Flat', 'Apartment', null]) {
        const items   = await fetchSlice(defn, dwelling);
        const grouped = groupByAreaAndBeds(items);
        for (const [area, bedGroups] of Object.entries(grouped)) {
          if (!isWaikato(area)) continue;
          if (!cache[defn][area]) cache[defn][area] = {};
          for (const [beds, rows] of Object.entries(bedGroups)) {
            const blended = blendRows(rows);
            if (blended) {
              const key = dwelling ? `${dwelling}:${beds}` : beds;
              cache[defn][area][key] = blended;
              results[defn]++;
            }
          }
        }
      }
    }

    // Pass 3: TA2019 per TA
    for (const [taName, taCode] of Object.entries(WAIKATO_TAS)) {
      cache.TA2019[taName] = cache.TA2019[taName] || {};
      for (const dwelling of ['House', 'Flat', 'Apartment', null]) {
        const params = new URLSearchParams({
          'period-ending': periodEnding(), 'num-months': '12',
          'area-definition': 'territorial-authority-2019',
          'area-codes': taCode,
        });
        if (dwelling) params.set('dwelling-type', dwelling);
        const r = await httpsGet(`/gateway/tenancy-services/market-rent/v2/statistics?${params}`);
        if (r.status !== 200) continue;
        const data  = JSON.parse(r.body);
        const items = Array.isArray(data) ? data : (data.items || data.data || []);
        const grouped = groupByAreaAndBeds(items);
        for (const [, bedGroups] of Object.entries(grouped)) {
          for (const [beds, rows] of Object.entries(bedGroups)) {
            const blended = blendRows(rows);
            if (blended) {
              const key = dwelling ? `${dwelling}:${beds}` : beds;
              cache.TA2019[taName][key] = blended;
              results.TA2019++;
            }
          }
        }
      }
    }

    // Write updated cache
    fs.writeFileSync(OUT_FILE, JSON.stringify(cache, null, 2));

    return res.status(200).json({
      success: true,
      generated: cache._meta.generated,
      results,
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
