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
 
  const LINZ_KEY = '91c5396319144ae68853f0de7f653d69';
 
  try {
    // ── BRAVE SEARCH ──
    if (service === 'brave') {
      const query = params.q || '';
      if (!query) return res.status(400).send('Missing query');
      const result = await httpsGet(
        'api.search.brave.com',
        `/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        { 'Accept': 'application/json', 'X-Subscription-Token': 'BSAUF6_k-NRyPrB0L-WGkV58i704aeR' }
      );
      return res.status(200).send(result.body);
    }
 
    // ── LINZ CAPABILITIES (to find correct layer names) ──
    if (service === 'linz-cap') {
      const result = await httpsGet(
        'data.linz.govt.nz',
        `/services;key=${LINZ_KEY}/wfs?service=WFS&version=2.0.0&request=GetCapabilities`,
        { 'Accept': 'application/xml' }
      );
      // Extract just FeatureType Names from XML
      const names = result.body.match(/<Name>[^<]+<\/Name>/g) || [];
      return res.status(200).json({ layers: names.slice(0, 50), raw: result.body.substring(0, 500) });
    }
 
    // ── LINZ ADDRESS LOOKUP via REST API ──
    if (service === 'linz') {
      const address = params.address || '';
      if (!address) return res.status(400).send('Missing address');
      // Use LINZ REST API instead of WFS
      const result = await httpsGet(
        'data.linz.govt.nz',
        `/services/api/v1/layers/53353/features/?q=${encodeURIComponent(address)}&format=json`,
        { 'Authorization': `key ${LINZ_KEY}`, 'Accept': 'application/json' }
      );
      return res.status(200).send(result.body);
    }
 
    // ── LINZ BUILDING OUTLINES (floor area) ──
    if (service === 'linz-building') {
      const lat = parseFloat(params.lat || '0');
      const lng = parseFloat(params.lng || '0');
      if (!lat || !lng) return res.status(400).send('Missing lat/lng');
      const delta = 0.0005;
      const bbox = `${lng-delta},${lat-delta},${lng+delta},${lat+delta}`;
      const result = await httpsGet(
        'data.linz.govt.nz',
        `/services;key=${LINZ_KEY}/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=layer-101290&outputFormat=application%2Fjson&count=10&bbox=${bbox},EPSG:4326`,
        { 'Accept': 'application/json' }
      );
      return res.status(200).send(result.body);
    }
 
    return res.status(400).json({ error: 'Unknown service' });
 
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
