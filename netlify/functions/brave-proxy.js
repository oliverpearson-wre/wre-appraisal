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
 
exports.handler = async function(event) {
  const params = event.queryStringParameters || {};
  const service = params.service || 'brave';
 
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };
 
  try {
    // ── BRAVE SEARCH ──
    if (service === 'brave') {
      const query = params.q || '';
      if (!query) return { statusCode: 400, body: 'Missing query' };
 
      const result = await httpsGet({
        hostname: 'api.search.brave.com',
        path: `/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': 'BSAUF6_k-NRyPrB0L-WGkV58i704aeR'
        }
      });
      return { statusCode: 200, headers: corsHeaders, body: result.body };
    }
 
    // ── LINZ PROPERTY DATA ──
    if (service === 'linz') {
      const address = params.address || '';
      if (!address) return { statusCode: 400, body: 'Missing address' };
 
      // Search NZ Address layer (layer 53353) - official NZ addresses with coordinates
      const addressQuery = encodeURIComponent(address);
      const linzPath = `/services;key=91c5396319144ae68853f0de7f653d69/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=layer-53353&outputFormat=application/json&count=5&CQL_FILTER=full_address+ILIKE+%27${addressQuery}%25%27`;
 
      const result = await httpsGet({
        hostname: 'data.linz.govt.nz',
        path: linzPath,
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      return { statusCode: 200, headers: corsHeaders, body: result.body };
    }
 
    // ── LINZ BUILDING OUTLINES ──
    if (service === 'linz-building') {
      const lat = params.lat || '';
      const lng = params.lng || '';
      if (!lat || !lng) return { statusCode: 400, body: 'Missing lat/lng' };
 
      // Building outlines layer (layer 101290) - includes floor area
      const bbox = `${parseFloat(lng)-0.001},${parseFloat(lat)-0.001},${parseFloat(lng)+0.001},${parseFloat(lat)+0.001}`;
      const linzPath = `/services;key=91c5396319144ae68853f0de7f653d69/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=layer-101290&outputFormat=application/json&count=5&bbox=${bbox},EPSG:4326`;
 
      const result = await httpsGet({
        hostname: 'data.linz.govt.nz',
        path: linzPath,
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      return { statusCode: 200, headers: corsHeaders, body: result.body };
    }
 
    return { statusCode: 400, body: 'Unknown service' };
 
  } catch(e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
};
