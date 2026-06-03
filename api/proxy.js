const https = require('https');

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = async function(req, res) {
  const params = req.query || {};
  const service = params.service || 'brave';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const LINZ_KEY    = '91c5396319144ae68853f0de7f653d69';
  const MBIE_KEY    = 'fe60f32fecf24e339f99e7d2b6ce0f82';
  const STATSNZ_KEY = '7971216ae5f34d349d80ce432613a303';
  const BRAVE_KEY   = 'BSAUF6_k-NRyPrB0L-WGkV58i704aeR';

  try {

    // ── BRAVE SEARCH ──
    if (service === 'brave') {
      const query = params.q || '';
      if (!query) return res.status(400).json({ error: 'Missing query' });
      const result = await httpsGet(
        'api.search.brave.com',
        `/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      );
      return res.status(200).send(result.body);
    }

    // ── MBIE MARKET RENT ──
    // https://api.mbie.govt.nz/mbie/opendata/v1/market-rent
    // Params: ?city=Hamilton&bedrooms=3&quarter=latest
    if (service === 'mbie-rent') {
      const city     = params.city     || 'Hamilton';
      const bedrooms = params.bedrooms || '3';
      const suburb   = params.suburb   || '';

      // MBIE Market Rent API endpoint
      const path = `/mbie/opendata/v1/market-rent?city=${encodeURIComponent(city)}&bedrooms=${encodeURIComponent(bedrooms)}&format=json`;
      const result = await httpsGet(
        'api.mbie.govt.nz',
        path,
        {
          'Accept': 'application/json',
          'Ocp-Apim-Subscription-Key': MBIE_KEY
        }
      );
      return res.status(result.status).send(result.body);
    }

    // ── MBIE MARKET RENT — TENANCY BOND ──
    // Alternative: use the tenancy bond data which is more reliable
    if (service === 'mbie-bond') {
      const ta = params.ta || 'Hamilton City';
      const path = `/mbie/opendata/v1/tenancy-bond-lodgements?ta=${encodeURIComponent(ta)}&format=json`;
      const result = await httpsGet(
        'api.mbie.govt.nz',
        path,
        {
          'Accept': 'application/json',
          'Ocp-Apim-Subscription-Key': MBIE_KEY
        }
      );
      return res.status(result.status).send(result.body);
    }

    // ── STATS NZ — Population / Demographics ──
    if (service === 'statsnz') {
      const dataset = params.dataset || 'nz-stat';
      const area    = params.area    || '';
      // Stats NZ Linked Data API
      const path = `/v1/dataset/${encodeURIComponent(dataset)}.json?area=${encodeURIComponent(area)}&limit=20`;
      const result = await httpsGet(
        'api.stats.govt.nz',
        path,
        {
          'Accept': 'application/json',
          'Authorization': `Bearer ${STATSNZ_KEY}`
        }
      );
      return res.status(result.status).send(result.body);
    }

    // ── STATS NZ — Suburb profile from Census ──
    if (service === 'statsnz-suburb') {
      const suburb = params.suburb || 'Flagstaff';
      const query  = encodeURIComponent(`${suburb} Hamilton population renter`);
      // Use Brave to search Stats NZ for suburb profile (fallback since Stats NZ API needs specific codes)
      const result = await httpsGet(
        'api.search.brave.com',
        `/res/v1/web/search?q=${query}+site:stats.govt.nz&count=5`,
        { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      );
      return res.status(200).send(result.body);
    }

    // ── TRADE ME RENTALS (via Brave) ──
    if (service === 'trademe-rentals') {
      const suburb   = params.suburb   || 'Flagstaff';
      const city     = params.city     || 'Hamilton';
      const bedrooms = params.bedrooms || '3';
      const query    = `site:trademe.co.nz/property/rent "${suburb}" OR "${city}" "${bedrooms} bedroom"`;
      const result = await httpsGet(
        'api.search.brave.com',
        `/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`,
        { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      );
      return res.status(200).send(result.body);
    }

    // ── LINZ CAPABILITIES ──
    if (service === 'linz-cap') {
      const result = await httpsGet(
        'data.linz.govt.nz',
        `/services;key=${LINZ_KEY}/wfs?service=WFS&version=2.0.0&request=GetCapabilities`,
        { 'Accept': 'application/xml' }
      );
      const names = result.body.match(/<Name>[^<]+<\/Name>/g) || [];
      return res.status(200).json({ layers: names.slice(0, 100) });
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
      const typename = 'data.linz.govt.nz:layer-101290';
      const result = await httpsGet(
        'data.linz.govt.nz',
        `/services;key=${LINZ_KEY}/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(typename)}&outputFormat=application%2Fjson&count=10&bbox=${bbox},EPSG:4326`,
        { 'Accept': 'application/json' }
      );
      return res.status(200).send(result.body);
    }

    return res.status(400).json({ error: 'Unknown service' });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
