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

// TA codes for MBIE area-definition territorial-authority-2019
const TA_CODES = {
  'Hamilton City': '107', 'Waikato District': '110', 'Waipa District': '111',
  'Matamata-Piako District': '112', 'Thames-Coromandel District': '114',
  'Hauraki District': '108', 'Otorohanga District': '115',
  'South Waikato District': '116', 'Taupo District': '118',
  'Waitomo District': '119', 'Auckland': '076', 'Wellington City': '049',
  'Christchurch City': '065', 'Tauranga City': '117', 'Dunedin City': '079',
  'Palmerston North City': '057', 'Nelson City': '062',
};

// Normalise city → TA name
function toTA(city) {
  if (TA_CODES[city]) return city;
  const withCity = city + ' City';
  if (TA_CODES[withCity]) return withCity;
  return city;
}

// period-ending = today minus 2 months yyyy-mm
function periodEnding() {
  const d = new Date(); d.setMonth(d.getMonth() - 2);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// Normalise bedrooms → MBIE num-bedrooms string
function bedsParam(n) {
  const b = parseInt(n); if (b >= 5) return '5+'; if (b >= 1) return String(b); return 'NA';
}

// Load the static MBIE cache (embedded JSON, updated by warm script)
let _mbieCache = null;
function getMBIECache() {
  if (_mbieCache) return _mbieCache;
  try {
    const p = path.join(__dirname, '../data/mbie-waikato.json');
    _mbieCache = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch(e) { _mbieCache = {}; }
  return _mbieCache;
}

// Look up from static cache: returns { lq, med, uq, nCurr, growth } or null
function cacheGet(taName, beds) {
  const cache = getMBIECache();
  const taCode = TA_CODES[taName];
  if (!taCode) return null;
  const row = cache?.[taName]?.[taCode]?.[beds];
  if (!row || !row.med) return null;
  return row;
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

    // ── MBIE MARKET RENT ──
    // 1. Serve instantly from static cache if available
    // 2. Fall back to live MBIE API if not in cache
    if (service === 'mbie-rent') {
      const city = params.city || 'Hamilton';
      const beds = bedsParam(params.bedrooms || '3');
      const ta   = toTA(city);
      const meta = getMBIECache()._meta || {};

      // Try static cache first — instant response
      const cached = cacheGet(ta, beds);
      if (cached) {
        return res.status(200).json({
          source:       'cache',
          generated:    meta.generated || 'unknown',
          period:       meta.period_ending || 'unknown',
          ta,
          beds,
          lq:     cached.lq,
          med:    cached.med,
          uq:     cached.uq,
          nCurr:  cached.nCurr,
          growth: cached.growth,
        });
      }

      // Not in cache — hit live MBIE API
      const taCode = TA_CODES[ta] || '107';
      const qs = new URLSearchParams({
        'period-ending':   periodEnding(),
        'num-months':      '12',
        'area-definition': 'territorial-authority-2019',
        'area-codes':      taCode,
        'num-bedrooms':    beds,
        'dwelling-type':   'House',
      }).toString();

      const result = await httpsGet(
        'api.business.govt.nz',
        `/gateway/tenancy-services/market-rent/v2/statistics?${qs}`,
        { 'Accept': 'application/json', 'Ocp-Apim-Subscription-Key': MBIE_KEY },
        240000
      );

      if (result.status === 200) {
        const data  = JSON.parse(result.body);
        const items = Array.isArray(data) ? data : (data.items || data.data || []);
        const rows  = items.filter(r => r.med != null && r.nCurr > 0);
        if (rows.length) {
          const totalW = rows.reduce((s, r) => s + r.nCurr, 0);
          const wMed   = Math.round(rows.reduce((s, r) => s + r.med * r.nCurr, 0) / totalW / 5) * 5;
          const wLq    = Math.round(rows.reduce((s, r) => s + r.lq  * r.nCurr, 0) / totalW / 5) * 5;
          const wUq    = Math.round(rows.reduce((s, r) => s + r.uq  * r.nCurr, 0) / totalW / 5) * 5;
          const sorted = [...rows].sort((a,b) => (a.period||'').localeCompare(b.period||''));
          const growth = sorted[0].med > 0
            ? parseFloat(((sorted[sorted.length-1].med - sorted[0].med) / sorted[0].med * 100).toFixed(1))
            : 4.8;
          return res.status(200).json({ source:'live', ta, beds, lq:wLq, med:wMed, uq:wUq, nCurr:totalW, growth });
        }
      }
      return res.status(result.status).send(result.body);
    }

    // ── STATS NZ suburb demographics via Brave ──
    if (service === 'statsnz-suburb') {
      const suburb = params.suburb || 'Flagstaff';
      const city   = params.city   || 'Hamilton';
      const query  = `"${suburb}" "${city}" census 2023 renters population household income stats.govt.nz`;
      const result = await httpsGet(
        'api.search.brave.com',
        `/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      );
      return res.status(200).send(result.body);
    }

    // ── TRADE ME RENTALS via Brave ──
    if (service === 'trademe-rentals') {
      const suburb   = params.suburb   || 'Flagstaff';
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
