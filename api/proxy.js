// proxy.js — cache-first MBIE strategy — deployed 2026-06-04
const https = require('https');
const fs    = require('fs');
const path  = require('path');

function httpsGet(hostname, p, headers, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: p, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

const LINZ_KEY  = '91c5396319144ae68853f0de7f653d69';
const MBIE_KEY  = 'fe60f32fecf24e339f99e7d2b6ce0f82';
const BRAVE_KEY = 'BSAUF6_k-NRyPrB0L-WGkV58i704aeR';

const TA_CODES = {
  'Hamilton City':'107','Waikato District':'110','Waipa District':'111',
  'Matamata-Piako District':'112','Thames-Coromandel District':'114',
  'Hauraki District':'108','Otorohanga District':'115',
  'South Waikato District':'116','Taupo District':'118','Waitomo District':'119',
  'Auckland':'076','Wellington City':'049','Christchurch City':'065',
  'Tauranga City':'117','Dunedin City':'079','Palmerston North City':'057',
};

function toTA(city) {
  if (TA_CODES[city]) return city;
  const w = city + ' City';
  if (TA_CODES[w]) return w;
  return city;
}

function periodEnding() {
  const d = new Date(); d.setMonth(d.getMonth() - 2);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function bedsKey(n) {
  const b = parseInt(n);
  if (b >= 5) return '5+';
  if (b >= 1) return String(b);
  return 'all';
}

// Load static cache fresh each time (file is small, disk read is fast)
function getCache() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../data/mbie-waikato.json'), 'utf8')); }
  catch(e) { return {}; }
}

// Estimate ladder: SAU2019 → IMR2017 → TA2019 → null
function cacheGet(suburb, city, beds) {
  const cache = getCache();
  const bk    = bedsKey(beds);
  const ta    = toTA(city);

  // Tier 1: SAU2019 — exact suburb match
  if (cache.SAU2019) {
    // Try exact match first
    const exact = cache.SAU2019[suburb] || cache.SAU2019[suburb + ' - ' + city];
    if (exact) {
      const row = exact[bk] || exact['all'];
      if (row?.med) return { ...row, source: 'SAU2019', area: suburb };
    }
    // Try partial match (suburb name appears in SAU label)
    const subLower = suburb.toLowerCase();
    for (const [area, data] of Object.entries(cache.SAU2019)) {
      if (area.toLowerCase().includes(subLower)) {
        const row = data[bk] || data['all'];
        if (row?.med) return { ...row, source: 'SAU2019', area };
      }
    }
  }

  // Tier 2: IMR2017 — suburb appears in cluster label
  if (cache.IMR2017) {
    const subLower = suburb.toLowerCase();
    for (const [area, data] of Object.entries(cache.IMR2017)) {
      if (area.toLowerCase().includes(subLower)) {
        const row = data[bk] || data['all'];
        if (row?.med) return { ...row, source: 'IMR2017', area };
      }
    }
  }

  // Tier 3: TA2019 — city level
  if (cache.TA2019?.[ta]) {
    const row = cache.TA2019[ta][bk] || cache.TA2019[ta]['all'];
    if (row?.med) return { ...row, source: 'TA2019', area: ta };
  }

  // Tier 4: TA2019 broadened (drop bedrooms)
  if (cache.TA2019?.[ta]) {
    const allBeds = Object.values(cache.TA2019[ta]).find(r => r?.med);
    if (allBeds) return { ...allBeds, source: 'TA2019-broad', area: ta };
  }

  return null;
}

module.exports = async function(req, res) {
  const params  = req.query || {};
  const service = params.service || 'brave';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {

    // ── BRAVE SEARCH ──
    if (service === 'brave') {
      const query = params.q || '';
      if (!query) return res.status(400).json({ error: 'Missing query' });
      const result = await httpsGet(
        'api.search.brave.com',
        `/res/v1/web/search?q=${encodeURIComponent(query)}&count=${params.count || 5}`,
        { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      );
      return res.status(200).send(result.body);
    }

    // ── MBIE MARKET RENT — cache-first with live fallback ──
    if (service === 'mbie-rent') {
      const suburb = params.suburb || '';
      const city   = params.city   || 'Hamilton';
      const beds   = params.bedrooms || '3';
      const meta   = getCache()._meta || {};

      // Try cache first (instant)
      const cached = cacheGet(suburb, city, beds);
      if (cached) {
        const growth = cached.growth >= 0 ? '+' + cached.growth + '%' : cached.growth + '%';
        return res.status(200).json({
          source:    'cache:' + cached.source,
          area:      cached.area,
          generated: meta.generated || 'unknown',
          lq: cached.lq, med: cached.med, uq: cached.uq,
          nCurr: cached.nCurr, growth,
        });
      }

      // Not in cache — live MBIE call (slow)
      const ta     = toTA(city);
      const taCode = TA_CODES[ta] || '107';
      const bk     = bedsKey(beds);
      const qs = new URLSearchParams({
        'period-ending':   periodEnding(),
        'num-months':      '12',
        'area-definition': 'territorial-authority-2019',
        'area-codes':      taCode,
      }).toString();

      const result = await httpsGet(
        'api.business.govt.nz',
        `/gateway/tenancy-services/market-rent/v2/statistics?${qs}`,
        { 'Accept': 'application/json', 'Ocp-Apim-Subscription-Key': MBIE_KEY },
        240000
      );

      if (result.status === 200) {
        const data  = JSON.parse(result.body);
        const items = (Array.isArray(data) ? data : (data.items || data.data || []))
          .filter(r => r.med != null && r.nCurr > 0
                    && (bk === 'all' || String(r.nB || r.numBedrooms || '') === bk));
        if (items.length) {
          const totalW = items.reduce((s, r) => s + r.nCurr, 0);
          const wMed   = Math.round(items.reduce((s, r) => s + r.med * r.nCurr, 0) / totalW / 5) * 5;
          const wLq    = Math.round(items.reduce((s, r) => s + r.lq  * r.nCurr, 0) / totalW / 5) * 5;
          const wUq    = Math.round(items.reduce((s, r) => s + r.uq  * r.nCurr, 0) / totalW / 5) * 5;
          return res.status(200).json({ source:'live', area:ta, lq:wLq, med:wMed, uq:wUq, nCurr:totalW, growth:'+4.8%' });
        }
      }
      return res.status(404).json({ error: 'No data found', city, beds });
    }

    // ── STATS NZ suburb demographics via Brave ──
    if (service === 'statsnz-suburb') {
      const suburb = params.suburb || 'Flagstaff';
      const city   = params.city   || 'Hamilton';
      const result = await httpsGet(
        'api.search.brave.com',
        `/res/v1/web/search?q=${encodeURIComponent(`"${suburb}" "${city}" census 2023 renters population household income stats.govt.nz`)}&count=5`,
        { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      );
      return res.status(200).send(result.body);
    }

    // ── TRADE ME RENTALS via Brave ──
    if (service === 'trademe-rentals') {
      const suburb   = params.suburb   || '';
      const city     = params.city     || 'Hamilton';
      const bedrooms = params.bedrooms || '3';
      const query    = `site:trademe.co.nz/property/rent ${suburb} ${city} ${bedrooms} bedroom per week`;
      const result   = await httpsGet(
        'api.search.brave.com',
        `/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`,
        { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      );
      return res.status(200).send(result.body);
    }

    // ── PROPERTY VALUE via Brave ──
    if (service === 'propertyvalue') {
      const address = params.address || '';
      const suburb  = params.suburb  || '';
      if (!address) return res.status(400).json({ error: 'Missing address' });
      const result  = await httpsGet(
        'api.search.brave.com',
        `/res/v1/web/search?q=${encodeURIComponent(`site:propertyvalue.co.nz "${address}${suburb ? ', '+suburb : ''}"`)}&count=5`,
        { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      );
      return res.status(200).send(result.body);
    }

    // ── LINZ ADDRESS LOOKUP ──
    if (service === 'linz') {
      const address = params.address || '';
      if (!address) return res.status(400).json({ error: 'Missing address' });
      const result  = await httpsGet(
        'data.linz.govt.nz',
        `/services;key=${LINZ_KEY}/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=data.linz.govt.nz:layer-53353&outputFormat=application%2Fjson&count=5&CQL_FILTER=${encodeURIComponent(`full_address ILIKE '${address}%'`)}`,
        { 'Accept': 'application/json' }
      );
      return res.status(200).send(result.body);
    }

    return res.status(400).json({ error: `Unknown service: ${service}` });

  } catch(e) {
    return res.status(500).json({ error: e.message, service });
  }
};
