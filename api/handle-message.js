import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';

// Initialize Twilio client (for signature validation)
const twilioClient = twilio();

export default async (req, res) => {
  // Set response headers
  res.setHeader('Content-Type', 'text/xml');
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    // 1. Validate Twilio request (security)
    const twilioSignature = req.headers['x-twilio-signature'];
    const url = process.env.BASE_URL + '/api/handle-message';
    const params = req.body;

    if (!twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      twilioSignature,
      url,
      params
    )) {
      console.error('Invalid Twilio signature');
      throw new Error('Invalid request');
    }

    // 2. Extract message data
    const userNumber = req.body.From;
    const userMessage = req.body.Body.trim().toLowerCase();
    console.log(`Message from ${userNumber}: "${userMessage}"`);

    // 3. Connect to Neon DB
    const neonClient = new Client(process.env.DATABASE_URL);
    await neonClient.connect();

    // 4. Track message count
    const { rows } = await neonClient.query(`
      INSERT INTO message_counts (user_number, count)
      VALUES ($1, 1)
      ON CONFLICT (user_number) 
      DO UPDATE SET count = message_counts.count + 1
      RETURNING count;
    `, [userNumber]);

    const currentCount = rows[0].count;

    // 5. Enforce 30-message limit
    if (currentCount > 30) {
      twiml.message("🚫 Free trial limit reached (30/30). Upgrade for unlimited messages.");
      return res.send(twiml.toString());
    }

    // 6. Hardcoded responses (replace with DB-stored Q&A later)
    const responses = {
      'hi': 'Hello! Thanks for messaging us.',
      'hello': 'Hello! How can I help?',
      'hours': 'We\'re open 9AM-6PM daily.',
      'location': 'Our office is in Bangalore, India.',
      'default': `You said: "${userMessage}". This is a test reply.`
    };

    // 7. Send response
    const reply = responses[userMessage] || responses.default;
    twiml.message(reply);
    console.log(`Replied to ${userNumber}: "${reply}"`);

  } catch (error) {
    console.error('Error:', error);
    twiml.message("⚠️ We're experiencing technical difficulties. Please try later.");
  } finally {
    // Close DB connection if it was opened
    if (neonClient) await neonClient.end();
  }

  // 8. Final response
  return res.send(twiml.toString());
};