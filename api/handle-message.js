const { Pool } = require('@neondatabase/serverless');
const twilio = require('twilio');

// Initialize Twilio with error handling
let twilioClient;
try {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  console.log('Twilio initialized successfully');
} catch (twilioError) {
  console.error('Twilio init failed:', twilioError);
  process.exit(1);
}

// Database pool with enhanced logging
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10000,
  allowExitOnIdle: true
});

// Pool event listeners for debugging
dbPool.on('connect', () => console.log('[DB] New connection'));
dbPool.on('acquire', () => console.log('[DB] Client acquired'));
dbPool.on('remove', () => console.log('[DB] Client removed'));

async function handleMessage(req, res) {
  console.log('\n=== NEW REQUEST ===');
  console.log('Incoming message:', {
    from: req.body.From,
    to: req.body.To,
    body: req.body.Body
  });

  // Phase 1: Immediate Twilio response
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message("We're processing your request...");
  try {
    res.setHeader('Content-Type', 'text/xml');
    res.send(twiml.toString());
    console.log('[1] Sent immediate response');
  } catch (resError) {
    console.error('Failed to send initial response:', resError);
    return;
  }

  // Phase 2: Database operations
  let client;
  try {
    console.log('[2] Acquiring DB client...');
    client = await dbPool.connect();
    console.log('[3] DB client acquired');

    // Verify table exists
    const testQuery = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'business_configs'
      )
    `);
    console.log('[4] Table exists:', testQuery.rows[0].exists);

    if (!testQuery.rows[0].exists) {
      throw new Error('business_configs table missing');
    }

    // Main query with parameterized input
    const query = {
      text: `
        SELECT business_name, language, qa_pairs 
        FROM business_configs 
        WHERE $1 = ANY(linked_numbers)
        LIMIT 1
      `,
      values: [req.body.To.replace('whatsapp:', '')]
    };
    console.log('[5] Executing query:', query);

    const { rows } = await client.query(query);
    console.log('[6] Query results:', rows.length ? 'Found' : 'Empty');

    // Fallback config if no DB results
    const config = rows[0] || {
      business_name: 'Default Business',
      language: 'English',
      qa_pairs: {
        "hello": "Hello from fallback config!",
        "hi": "Hi there! How can we help?"
      }
    };
    console.log('[7] Using config:', config.business_name);

    // Phase 3: Response generation
    const response = generateResponse(req.body.Body, config);
    console.log('[8] Generated response:', response);

    // Phase 4: Twilio reply
    console.log('[9] Sending via Twilio...');
    await twilioClient.messages.create({
      body: response,
      from: req.body.To,
      to: req.body.From
    });
    console.log('[10] Twilio reply sent');

    // Phase 5: Log to database (non-blocking)
    await client.query(
      `INSERT INTO message_logs 
       (business_number, customer_number, message, response) 
       VALUES ($1, $2, $3, $4)`,
      [req.body.To, req.body.From, req.body.Body, response]
    );
    console.log('[11] Logged to database');

  } catch (error) {
    console.error('[ERROR] Processing failed:', {
      message: error.message,
      stack: error.stack,
      twilioSid: req.body.MessageSid
    });

    // Emergency fallback reply
    try {
      await twilioClient.messages.create({
        body: "We're experiencing technical difficulties. Please try again later.",
        from: req.body.To,
        to: req.body.From
      });
      console.log('[FALLBACK] Sent error notification');
    } catch (twilioError) {
      console.error('[CRITICAL] Twilio fallback failed:', twilioError);
    }
  } finally {
    if (client) {
      client.release();
      console.log('[12] DB client released');
    }
  }
}

function generateResponse(message, config) {
  const lowerMsg = message.toLowerCase();
  
  // 1. Check exact matches in qa_pairs
  if (config.qa_pairs[lowerMsg]) {
    return config.qa_pairs[lowerMsg];
  }

  // 2. Check partial matches
  for (const [question, answer] of Object.entries(config.qa_pairs)) {
    if (lowerMsg.includes(question.toLowerCase())) {
      return answer;
    }
  }

  // 3. Hardcoded fallbacks
  if (lowerMsg.includes('hello') || lowerMsg.includes('hi')) {
    return `Hello from ${config.business_name}! How can we help?`;
  }
  if (lowerMsg.includes('hour')) {
    return "Our hours are Mon-Fri 9AM-5PM";
  }

  // 4. Ultimate fallback
  return "Thanks for your message! We'll respond shortly.";
}

module.exports = handleMessage;
