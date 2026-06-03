const https = require('https');
 
exports.handler = async function(event) {
  const BRAVE_KEY = 'BSAUF6_k-NRyPrB0L-WGkV58i704aeR';
  const query = event.queryStringParameters?.q || '';
 
  if (!query) return { statusCode: 400, body: 'Missing query' };
 
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.search.brave.com',
      path: `/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_KEY
      }
    };
 
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: data
        });
      });
    });
 
    req.on('error', (e) => {
      resolve({
        statusCode: 500,
        body: JSON.stringify({ error: e.message })
      });
    });
 
    req.end();
  });
};
