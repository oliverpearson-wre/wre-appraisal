exports.handler = async function(event) {
  const BRAVE_KEY = 'BSAUF6_k-NRyPrB0L-WGkV58i704aeR';
  const query = event.queryStringParameters?.q || '';

  if (!query) return { statusCode: 400, body: 'Missing query' };

  try {
    const resp = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_KEY
        }
      }
    );
    const data = await resp.json();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(data)
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
