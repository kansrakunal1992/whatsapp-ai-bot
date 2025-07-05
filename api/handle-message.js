import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

const twiml = new twilio.twiml.MessagingResponse();

// Constants
const SANDBOX_NUMBERS = new Set([
  'whatsapp:+14155238886',
  '+14155238886',
  ...(process.env.TWILIO_SANDBOX_NUMBERS?.split(',') || []).map(n => n.trim())
]);

// Configuration
const DB_CONFIG = {
  connectionString: process.env.DATABASE_URL,
  idleTimeoutMillis: 5000,
  max: 5
};

const safeString = (str, maxLength) => str ? String(str).slice(0, maxLength) : null;

export default async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');
  const client = new Client(DB_CONFIG);
  let responseSent = false;

  try {
    // 1. Process sandbox activation
    const userMessage = req.body.Body?.trim().toLowerCase() || '';
    if (userMessage.startsWith('join')) {
      twiml.message("🚀 You're connected! Ask us anything anytime.");
      return res.send(twiml.toString());
    }

    // 2. Clean and validate numbers
    const fromNumber = safeString(req.body.From, 50);
    const toNumber = safeString(req.body.To, 50);
    const cleanNumber = toNumber.replace('whatsapp:', '');
    const isSandbox = SANDBOX_NUMBERS.has(toNumber) || SANDBOX_NUMBERS.has(cleanNumber);

    // 3. Database operations
    await client.connect();
    const messageId = safeString(req.body.MessageSid || req.body.SmsSid, 34);

    // 4. Get business config (including operating hours as regular Q&A context)
    let config = {
      business_name: 'Our Business',
      location: 'our location',
      language: 'English',
      qa_pairs: {}
    };

    if (!isSandbox) {
      const { rows } = await client.query(
        `SELECT 
          business_name, location, language,
          operating_hours,
          qa_pairs
         FROM business_configs
         WHERE $1 = ANY(linked_numbers) OR whatsapp_number = $1
         LIMIT 1`,
        [cleanNumber]
      );
      
      if (rows[0]) {
        config = rows[0];
        // Automatically include operating hours in Q&A context
        if (config.operating_hours) {
          config.qa_pairs = {
            ...config.qa_pairs,
            "What are your opening hours?": `We're open ${config.operating_hours.opening} to ${config.operating_hours.closing}`,
            "When are you open?": `Our business hours are ${config.operating_hours.opening} to ${config.operating_hours.closing}`
          };
        }
      }
    }

    // 5. Generate AI response (business hours handled naturally through Q&A)
    const aiResponse = await getAIResponse(
      safeString(req.body.Body, 1000),
      {
        businessName: config.business_name,
        location: config.location,
        knownAnswers: config.qa_pairs || {}
      },
      config.language
    );

    // 6. Send response
    twiml.message(safeString(aiResponse, 1000));
    res.send(twiml.toString());
    responseSent = true;

    // 7. Log message
    await client.query(
      `INSERT INTO messages (
        user_number, business_number,
        message, response,
        is_sandbox, message_id,
        created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        fromNumber,
        isSandbox ? 'SANDBOX' : cleanNumber,
        safeString(req.body.Body, 1000),
        safeString(aiResponse, 1000),
        isSandbox,
        messageId
      ]
    );

  } catch (error) {
    console.error("PROCESSING FAILED:", {
      error: error.message,
      timestamp: new Date().toISOString()
    });

    if (!responseSent) {
      twiml.message("We're experiencing high demand. Please try again shortly.");
      res.send(twiml.toString());
    }

  } finally {
    try {
      await client.end();
    } catch (dbError) {
      console.error('DB cleanup error:', dbError.message);
    }
  }
};