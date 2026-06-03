const https = require('https');
 
function httpsGet(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
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
 
  try {
    // ── BRAVE SEARCH ──
    if (service === 'brave') {
      const query = params.q || '';
      if (!query) return res.status(400).send('Missing query');
      const result = await httpsGet({
        hostname: 'api.search.brave.com',
        path: `/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': 'BSAUF6_k-NRyPrB0L-WGkV58i704aeR'
        }
      });
      return res.status(200).send(result.body);
    }
 
    // ── LINZ ADDRESS LOOKUP ──
    if (service === 'linz') {
      const address = params.address || '';
      if (!address) return res.status(400).send('Missing address');
      const linzPath = `/services;key=91c5396319144ae68853f0de7f653d69/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=layer-53353&outputFormat=application/json&count=5&CQL_FILTER=full_address+ILIKE+%27${encodeURIComponent(address)}%25%27`;
      const result = await httpsGet({
        hostname: 'data.linz.govt.nz',
        path: linzPath,
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      return res.status(200).send(result.body);
    }
 
    // ── LINZ BUILDING OUTLINES (floor area) ──
    if (service === 'linz-building') {
      const lat = params.lat || '';
      const lng = params.lng || '';
      if (!lat || !lng) return res.status(400).send('Missing lat/lng');
      const delta = 0.001;
      const bbox = `${parseFloat(lng)-delta},${parseFloat(lat)-delta},${parseFloat(lng)+delta},${parseFloat(lat)+delta}`;
      const linzPath = `/services;key=91c5396319144ae68853f0de7f653d69/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=layer-101290&outputFormat=application/json&count=5&bbox=${bbox},EPSG:4326`;
      const result = await httpsGet({
        hostname: 'data.linz.govt.nz',
        path: linzPath,
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      return res.status(200).send(result.body);
    }
 
    // ── LINZ PROPERTY TITLES (parcel data) ──
    if (service === 'linz-parcel') {
      const lat = params.lat || '';
      const lng = params.lng || '';
      if (!lat || !lng) return res.status(400).send('Missing lat/lng');
      const delta = 0.001;
      const bbox = `${parseFloat(lng)-delta},${parseFloat(lat)-delta},${parseFloat(lng)+delta},${parseFloat(lat)+delta}`;
      const linzPath = `/services;key=91c5396319144ae68853f0de7f653d69/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=layer-50804&outputFormat=application/json&count=5&bbox=${bbox},EPSG:4326`;
      const result = await httpsGet({
        hostname: 'data.linz.govt.nz',
        path: linzPath,
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      return res.status(200).send(result.body);
    }
 
    return res.status(400).send('Unknown service');
 
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
