const { Pool } = require('@neondatabase/serverless');
const twilio = require('twilio');

// Initialize Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Database pool with proper configuration
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  allowExitOnIdle: true
});

// Debug connection events
dbPool.on('connect', () => console.log('[DB] New connection'));
dbPool.on('acquire', () => console.log('[DB] Client acquired'));
dbPool.on('remove', () => console.log('[DB] Client released'));

async function handleMessage(req, res) {
  console.log('\n=== INCOMING MESSAGE ===');
  console.log('From:', req.body.From);
  console.log('Body:', req.body.Body);

  // 1. Immediate response
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message("We're processing your request...");
  res.setHeader('Content-Type', 'text/xml');
  res.send(twiml.toString());

  let client;
  try {
    // 2. Get database connection
    client = await dbPool.connect();
    console.log('[DB] Connection established');

    // 3. Query config (using DISTINCT to handle any remaining duplicates)
    const { rows } = await client.query(`
      SELECT DISTINCT ON (whatsapp_number) 
        whatsapp_number, 
        business_name,
        qa_pairs
      FROM business_configs
      WHERE $1 = ANY(linked_numbers)
        OR whatsapp_number = $1
      LIMIT 1
    `, [req.body.To.replace('whatsapp:', '')]);

    if (!rows.length) {
      throw new Error('No business config found');
    }

    const config = rows[0];
    console.log('[CONFIG] Using:', config.business_name);

    // 4. Generate response
    const response = generateResponse(req.body.Body, config);
    console.log('[RESPONSE]', response);

    // 5. Send reply
    await twilioClient.messages.create({
      body: response,
      from: req.body.To,
      to: req.body.From
    });

    // 6. Log conversation
    await client.query(`
      INSERT INTO message_logs 
      (business_number, customer_number, message, response)
      VALUES ($1, $2, $3, $4)
    `, [
      req.body.To.replace('whatsapp:', ''),
      req.body.From.replace('whatsapp:', ''),
      req.body.Body,
      response
    ]);

  } catch (error) {
    console.error('[ERROR]', error);
    // Fallback response
    await twilioClient.messages.create({
      body: "We're currently upgrading our system. Please message again in a few minutes.",
      from: req.body.To,
      to: req.body.From
    });
  } finally {
    if (client) client.release();
  }
}

function generateResponse(message, config) {
  const lowerMsg = message.toLowerCase().trim();
  
  // 1. Check exact matches
  if (config.qa_pairs[lowerMsg]) {
    return config.qa_pairs[lowerMsg];
  }

  // 2. Check partial matches
  for (const [question, answer] of Object.entries(config.qa_pairs)) {
    if (lowerMsg.includes(question.toLowerCase())) {
      return answer;
    }
  }

  // 3. Default responses
  return `Thanks for contacting ${config.business_name}! We'll respond soon.`;
}

module.exports = handleMessage;
