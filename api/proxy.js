const https = require('https');

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

const LINZ_KEY    = '91c5396319144ae68853f0de7f653d69';
const MBIE_KEY    = 'fe60f32fecf24e339f99e7d2b6ce0f82';
const STATSNZ_KEY = '7971216ae5f34d349d80ce432613a303';
const BRAVE_KEY   = 'BSAUF6_k-NRyPrB0L-WGkV58i704aeR';

module.exports = async function(req, res) {
  const params = req.query || {};
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
        `/res/v1/web/search?q=${encodeURIComponent(query)}&count=${params.count||5}`,
        { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      );
      return res.status(200).send(result.body);
    }

    // ── MBIE MARKET RENT ──
    // Correct endpoint: https://api.mbie.govt.nz/mbie/opendata/v1/rental-bond-data
    if (service === 'mbie-rent') {
      const ta       = params.ta       || 'Hamilton City';
      const bedrooms = params.bedrooms || '';

      // Try the MBIE Tenancy Services rental bond API (correct public endpoint)
      let path = `/mbie/opendata/v1/rental-bond-data?ta=${encodeURIComponent(ta)}&format=json`;
      if (bedrooms) path += `&bedrooms=${encodeURIComponent(bedrooms)}`;

      let result = await httpsGet(
        'api.mbie.govt.nz', path,
        { 'Accept': 'application/json', 'Ocp-Apim-Subscription-Key': MBIE_KEY }
      );

      // If that fails, try the market rent summary endpoint
      if (result.status !== 200) {
        path = `/mbie/opendata/v1/market-rent-summary?ta=${encodeURIComponent(ta)}&format=json`;
        result = await httpsGet(
          'api.mbie.govt.nz', path,
          { 'Accept': 'application/json', 'Ocp-Apim-Subscription-Key': MBIE_KEY }
        );
      }

      // Last resort: try without key (some MBIE endpoints are open)
      if (result.status !== 200) {
        path = `/mbie/opendata/v1/rental-bond-data?ta=${encodeURIComponent(ta)}&format=json`;
        result = await httpsGet(
          'api.mbie.govt.nz', path,
          { 'Accept': 'application/json' }
        );
      }

      return res.status(result.status).send(result.body);
    }

    // ── MBIE RENT VIA BRAVE (reliable fallback) ──
    // Searches for MBIE/Tenancy Services data about specific area
    if (service === 'mbie-brave') {
      const suburb   = params.suburb   || '';
      const city     = params.city     || 'Hamilton';
      const bedrooms = params.bedrooms || '3';
      const query = `MBIE tenancy bond rent "${city}" ${bedrooms} bedroom median 2025 2026 weekly`;
      const result = await httpsGet(
        'api.search.brave.com',
        `/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      );
      return res.status(200).send(result.body);
    }

    // ── STATS NZ — Census suburb data via Linked Data API ──
    // Correct endpoint: https://api.stats.govt.nz/opendata/v1/
    if (service === 'statsnz') {
      const dataset = params.dataset || 'CPP2018-CEN2018';
      const path = `/opendata/v1/dataset/${encodeURIComponent(dataset)}.json?limit=5`;
      const result = await httpsGet(
        'api.stats.govt.nz', path,
        { 'Accept': 'application/json', 'Ocp-Apim-Subscription-Key': STATSNZ_KEY }
      );
      return res.status(result.status).send(result.body);
    }

    // ── STATS NZ — suburb demographics via Brave ──
    if (service === 'statsnz-suburb') {
      const suburb = params.suburb || 'Flagstaff';
      const city   = params.city   || 'Hamilton';
      // Search for census suburb profile
      const query = `"${suburb}" "${city}" census 2023 renters population household income stats.govt.nz OR "Statistics New Zealand"`;
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
      // More targeted query for actual listings with prices
      const query = `site:trademe.co.nz/property/rent ${bedrooms}-bedroom ${suburb} ${city} per week`;
      const result = await httpsGet(
        'api.search.brave.com',
        `/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`,
        { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      );
      return res.status(200).send(result.body);
    }

    // ── TRADE ME — broader search if suburb yields no results ──
    if (service === 'trademe-city') {
      const city     = params.city     || 'Hamilton';
      const bedrooms = params.bedrooms || '3';
      const query = `site:trademe.co.nz/property/rent ${bedrooms} bedroom ${city} per week $`;
      const result = await httpsGet(
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
      const query = `site:propertyvalue.co.nz "${address}${suburb ? ', ' + suburb : ''}"`;
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
      const typename = 'data.linz.govt.nz:layer-53353';
      const filter = `full_address ILIKE '${address}%'`;
      const result = await httpsGet(
        'data.linz.govt.nz',
        `/services;key=${LINZ_KEY}/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(typename)}&outputFormat=application%2Fjson&count=5&CQL_FILTER=${encodeURIComponent(filter)}`,
        { 'Accept': 'application/json' }
      );
      return res.status(200).send(result.body);
    }

    // ── LINZ BUILDING OUTLINES ──
    if (service === 'linz-building') {
      const lat = parseFloat(params.lat || '0');
      const lng = parseFloat(params.lng || '0');
      if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });
      const delta = 0.0005;
      const bbox = `${lng-delta},${lat-delta},${lng+delta},${lat+delta}`;
      const result = await httpsGet(
        'data.linz.govt.nz',
        `/services;key=${LINZ_KEY}/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=data.linz.govt.nz:layer-101290&outputFormat=application%2Fjson&count=10&bbox=${bbox},EPSG:4326`,
        { 'Accept': 'application/json' }
      );
      return res.status(200).send(result.body);
    }

    return res.status(400).json({ error: `Unknown service: ${service}` });

  } catch(e) {
    return res.status(500).json({ error: e.message, service });
  }
};
