import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
  // Initialize response
  res.setHeader('Content-Type', 'text/xml');
  const twiml = new MessagingResponse();
  let neonClient;

  try {
    // 1. Validate Twilio request (if auth token exists)
    if (process.env.TWILIO_AUTH_TOKEN) {
      const validator = require('twilio').validateRequest;
      const isValid = validator(
        process.env.TWILIO_AUTH_TOKEN,
        req.headers['x-twilio-signature'],
        process.env.BASE_URL + '/api/handle-message',
        req.body
      );
      if (!isValid) throw new Error('Invalid Twilio signature');
    }

    // 2. Connect to Neon
    neonClient = new Client(process.env.DATABASE_URL);
    await neonClient.connect();

    // 3. Process message
    const userNumber = req.body.From;
    const userMessage = req.body.Body.trim().toLowerCase();

    // 4. Update message count
    const { rows } = await neonClient.query(`
      INSERT INTO message_counts (user_number, count)
      VALUES ($1, 1)
      ON CONFLICT (user_number) 
      DO UPDATE SET count = message_counts.count + 1
      RETURNING count;
    `, [userNumber]);

    // 5. Check limit
    if (rows[0].count > 30) {
      twiml.message("Free trial limit reached (30/30).");
      return res.send(twiml.toString());
    }

    // 6. Simple responses
    const reply = {
      'hi': 'Hello!',
      'hello': 'Hi there!',
      'hours': 'Open 9AM-6PM',
      'default': `You said: ${userMessage}`
    }[userMessage] || 'default';

    twiml.message(reply);

  } catch (error) {
    console.error('Error:', error);
    twiml.message("⚠️ Temporary system issue. Try again later.");
  } finally {
    if (neonClient) await neonClient.end();
  }

  return res.send(twiml.toString());
};

// Minimal Twilio import (no full client initialization)
const { MessagingResponse } = require('twilio').twiml;