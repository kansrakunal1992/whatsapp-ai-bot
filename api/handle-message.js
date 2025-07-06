const { Pool } = require('@neondatabase/serverless');
const twilio = require('twilio');

// Initialize Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Singleton DB Pool (critical for serverless)
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,                  // Optimized for Vercel
  idleTimeoutMillis: 10000, // Close idle connections after 10s
  allowExitOnIdle: true     // Required for serverless environments
});

// Debug connection pooling
let activeClients = 0;
dbPool.on('connect', () => {
  activeClients++;
  console.log(`[DB] New connection. Active: ${activeClients}`);
});
dbPool.on('remove', () => {
  activeClients--;
  console.log(`[DB] Connection released. Active: ${activeClients}`);
});

async function handleMessage(req, res) {
  console.log('\n=== INCOMING MESSAGE ===');
  console.log('From:', req.body.From);
  console.log('Body:', req.body.Body);

  // Immediate Twilio response
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message("We're processing your request...");
  res.setHeader('Content-Type', 'text/xml');
  res.send(twiml.toString());

  let client;
  try {
    // 1. Get database client from pool
    client = await dbPool.connect();
    console.log('[DB] Client acquired from pool');

    // 2. Query business config (with error handling)
    const { rows } = await client.query(`
      SELECT * FROM business_configs 
      WHERE $1 = ANY(linked_numbers) 
      LIMIT 1
    `, [req.body.To.replace('whatsapp:', '')]);

    const config = rows[0] || {
      business_name: 'Default Business',
      language: 'English',
      qa_pairs: {}
    };
    console.log('[DB] Config loaded:', config.business_name);

    // 3. Generate response
    const response = generateResponse(req.body.Body, config);
    console.log('[AI] Generated response:', response);

    // 4. Send reply
    await twilioClient.messages.create({
      body: response,
      from: req.body.To,
      to: req.body.From
    });
    console.log('[Twilio] Response sent');

    // 5. Log to database (non-blocking)
    await client.query(`
      INSERT INTO message_logs 
      (business_number, customer_number, message, response) 
      VALUES ($1, $2, $3, $4)
    `, [req.body.To, req.body.From, req.body.Body, response]);

  } catch (error) {
    console.error('[ERROR]', error);
    // Fallback response
    await twilioClient.messages.create({
      body: "We're experiencing high demand. Please try again later.",
      from: req.body.To,
      to: req.body.From
    });
  } finally {
    // 6. Always release client
    if (client) {
      client.release();
      console.log('[DB] Client released');
    }
  }
}

// Simplified response generator
function generateResponse(message, config) {
  const lowerMsg = message.toLowerCase();
  if (lowerMsg.includes('hello') || lowerMsg.includes('hi')) {
    return `Hello! Thanks for contacting ${config.business_name}.`;
  }
  if (lowerMsg.includes('hour')) {
    return "We're open Mon-Fri, 9AM-5PM.";
  }
  return config.qa_pairs[message] || "We'll get back to you soon!";
}

module.exports = handleMessage;
