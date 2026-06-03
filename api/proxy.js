const https = require('https');

function httpsGet(hostname, path, headers, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

const LINZ_KEY    = '91c5396319144ae68853f0de7f653d69';
const MBIE_KEY    = 'fe60f32fecf24e339f99e7d2b6ce0f82';
const BRAVE_KEY   = 'BSAUF6_k-NRyPrB0L-WGkV58i704aeR';

// MBIE area code cache (TA codes don't change — safe to hardcode)
// From: GET /area-definitions/territorial-authority-2019
const TA_CODES = {
  'Hamilton City': '107',
  'Waikato District': '110',
  'Waipa District': '111',
  'Auckland': '076',
  'Wellington City': '049',
  'Christchurch City': '065',
  'Tauranga City': '117',
  'Dunedin City': '079',
  'Palmerston North City': '057',
  'Nelson City': '062',
};

// Map bedrooms int → MBIE num-bedrooms string
function bedroomsParam(n) {
  const b = parseInt(n);
  if (b >= 5) return '5+';
  if (b >= 1) return String(b);
  return 'NA';
}

// Compute period-ending = today minus 2 months, yyyy-mm
function periodEnding() {
  const d = new Date();
  d.setMonth(d.getMonth() - 2);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
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
    // Correct base: api.business.govt.nz/gateway/tenancy-services/market-rent/v2
    if (service === 'mbie-rent') {
      const city     = params.city     || 'Hamilton City';
      const bedrooms = params.bedrooms || '3';
      const ta       = city.includes('City') || city.includes('District') ? city : city + ' City';
      const taCode   = TA_CODES[ta] || TA_CODES[city] || '107'; // default Hamilton City

      const numBedrooms = bedroomsParam(bedrooms);
      const period      = periodEnding();

      const qs = new URLSearchParams({
        'period-ending':   period,
        'num-months':      '12',
        'area-definition': 'territorial-authority-2019',
        'area-codes':      taCode,
        'num-bedrooms':    numBedrooms,
        'dwelling-type':   'House',
      }).toString();

      const path   = `/gateway/tenancy-services/market-rent/v2/statistics?${qs}`;
      const result = await httpsGet(
        'api.business.govt.nz', path,
        {
          'Accept': 'application/json',
          'Ocp-Apim-Subscription-Key': MBIE_KEY
        },
        240000  // 4 min timeout — first call can be slow
      );

      return res.status(result.status).send(result.body);
    }

    // ── MBIE AREA DEFINITIONS (lookup TA codes) ──
    if (service === 'mbie-areas') {
      const defn   = params.defn || 'territorial-authority-2019';
      const result = await httpsGet(
        'api.business.govt.nz',
        `/gateway/tenancy-services/market-rent/v2/area-definitions/${defn}`,
        { 'Accept': 'application/json', 'Ocp-Apim-Subscription-Key': MBIE_KEY },
        30000
      );
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
      const query  = `site:propertyvalue.co.nz "${address}${suburb ? ', ' + suburb : ''}"`;
      const result = await httpsGet(
        'api.search.brave.com',
        `/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      );
      return res.status(200).send(result.body);
    }

    // ── LINZ ADDRESS LOOKUP ──
    if (service === 'linz') {
      const address = params.address || '';
      if (!address) return res.status(400).json({ error: 'Missing address' });
      const filter  = `full_address ILIKE '${address}%'`;
      const result  = await httpsGet(
        'data.linz.govt.nz',
        `/services;key=${LINZ_KEY}/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=data.linz.govt.nz:layer-53353&outputFormat=application%2Fjson&count=5&CQL_FILTER=${encodeURIComponent(filter)}`,
        { 'Accept': 'application/json' }
      );
      return res.status(200).send(result.body);
    }

    return res.status(400).json({ error: `Unknown service: ${service}` });

  } catch(e) {
    return res.status(500).json({ error: e.message, service });
  }
};
