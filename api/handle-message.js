const { Pool } = require('@neondatabase/serverless');
const twilio = require('twilio');

// Initialize Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function handleMessage(req, res) {
  console.log('\n=== NEW MESSAGE RECEIVED ===');
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  // Immediate response
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message("We're processing your request...");
  res.setHeader('Content-Type', 'text/xml');
  res.send(twiml.toString());

  try {
    const { Body, From, To } = req.body;
    const userMessage = Body || '';
    const fromNumber = From;
    const toNumber = To;

    console.log('\n[1] Basic message info extracted');

    // 1. Check if this is a sandbox join message
    if (toNumber.includes('14155238886') && userMessage.toLowerCase().startsWith('join')) {
      console.log('[2] Detected sandbox join message');
      await sendMessage(fromNumber, toNumber, "🚀 You're connected! Ask me anything.");
      return;
    }

    console.log('[3] Not a sandbox join message, proceeding normally');

    // 2. Get business config
    let config;
    try {
      const { rows } = await dbPool.query(
        `SELECT * FROM business_configs 
         WHERE $1 = ANY(linked_numbers) 
         LIMIT 1`,
        [toNumber.replace('whatsapp:', '')]
      );
      config = rows[0] || {
        business_name: 'Test Business',
        language: 'English',
        qa_pairs: {}
      };
      console.log('[4] Business config loaded:', config);
    } catch (dbError) {
      console.error('[4] Database error:', dbError);
      await sendMessage(fromNumber, toNumber, "⚠️ Configuration error. Please try again later.");
      return;
    }

    // 3. Generate response (simplified)
    let response;
    if (userMessage.toLowerCase().includes('hello')) {
      response = `Hello! Thanks for contacting ${config.business_name}.`;
    } else if (userMessage.toLowerCase().includes('hours')) {
      response = "We're open Monday to Friday, 9AM to 5PM.";
    } else {
      response = "Thanks for your message! We'll get back to you soon.";
    }

    console.log('[5] Generated response:', response);

    // 4. Send response
    await sendMessage(fromNumber, toNumber, response);
    console.log('[6] Response sent successfully');

    // 5. Store in database (non-blocking)
    dbPool.query(
      `INSERT INTO message_logs (business_number, customer_number, message, response) 
       VALUES ($1, $2, $3, $4)`,
      [toNumber, fromNumber, userMessage, response]
    ).catch(e => console.error('[7] Database save error:', e));

  } catch (error) {
    console.error('[ERROR] Main handler error:', error);
    await sendMessage(req.body.From, req.body.To, 
      "⚠️ We encountered an error. Our team has been notified.");
  }
}

async function sendMessage(to, from, body) {
  console.log(`Attempting to send to ${to}:`, body);
  try {
    await twilioClient.messages.create({
      body: body,
      from: from,
      to: to
    });
    console.log('Message sent successfully');
  } catch (err) {
    console.error('Twilio send error:', err);
    throw err;
  }
}

module.exports = handleMessage;
