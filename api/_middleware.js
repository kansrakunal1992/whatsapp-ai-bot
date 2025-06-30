export default function middleware(req) {
  // Set CORS headers
  const res = new Response(JSON.stringify({ message: "Success" }), {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  return res;
}
