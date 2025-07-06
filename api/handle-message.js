const { Pool } = require('@neondatabase/serverless');
const twilio = require('twilio');

// Initialize Twilio with error handling
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Database pool configuration for Vercel
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10000,
  allowExitOnIdle: true
});

// Debug connection pool events
dbPool.on('connect', () => console.log('[DB] New connection'));
dbPool.on('acquire', () => console.log('[DB] Client acquired'));
dbPool.on('remove', () => console.log('[DB] Client released'));

async function handleMessage(req, res) {
  console.log('\n=== INCOMING MESSAGE ===');
  console.log('From:', req.body.From);
  console.log('To:', req.body.To);
  console.log('Body:', req.body.Body);

  // 1. Immediate response (avoid Twilio timeout)
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message("We're processing your request...");
  res.setHeader('Content-Type', 'text/xml');
  res.send(twiml.toString());

  let client;
  try {
    // 2. Get database connection
    client = await dbPool.connect();
    console.log('[DB] Connection established');

    // 3. Find business config (supports both sandbox and production)
    const twilioNumber = req.body.To.replace('whatsapp:', '');
    const { rows } = await client.query(`
      SELECT * FROM business_configs 
      WHERE $1 = ANY(linked_numbers) OR whatsapp_number = $1
      LIMIT 1
    `, [twilioNumber]);

    if (!rows.length) {
      throw new Error(`No config found for number: ${twilioNumber}`);
    }

    const config = rows[0];
    console.log('[CONFIG] Loaded:', config.business_name);

    // 4. Generate response
    const response = generateResponse(req.body.Body, config);
    console.log('[RESPONSE]', response);

    // 5. Send reply via Twilio
    await twilioClient.messages.create({
      body: response,
      from: req.body.To,
      to: req.body.From
    });

    // 6. Log conversation (non-blocking)
    await client.query(`
      INSERT INTO message_logs 
      (business_number, customer_number, message, response) 
      VALUES ($1, $2, $3, $4)
    `, [twilioNumber, req.body.From.replace('whatsapp:', ''), req.body.Body, response]);

  } catch (error) {
    console.error('[ERROR]', error);
    
    // Emergency fallback
    try {
      await twilioClient.messages.create({
        body: "We're upgrading our systems. Please try again in 5 minutes.",
        from: req.body.To,
        to: req.body.From
      });
    } catch (twilioError) {
      console.error('[CRITICAL] Fallback failed:', twilioError);
    }
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
  if (/hello|hi|hey/.test(lowerMsg)) {
    return `Hello! Thanks for contacting ${config.business_name}.`;
  }
  if (/hour|time|open/.test(lowerMsg)) {
    return "Our hours are 9AM-5PM Monday to Friday.";
  }

  // 4. Ultimate fallback
  return "Thanks for your message! We'll respond shortly.";
}

module.exports = handleMessage;
