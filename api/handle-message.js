import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

const twiml = new twilio.twiml.MessagingResponse();

// Enhanced Configuration
const SANDBOX_NUMBERS = new Set([
  'whatsapp:+14155238886', // Twilio Sandbox
  '+14155238886',
  ...(process.env.TWILIO_SANDBOX_NUMBERS?.split(',') || [])
]);

const DB_CONFIG = {
  connectionString: process.env.DATABASE_URL,
  idleTimeoutMillis: 5000,
  max: 5
};

// Helper: Clean and truncate strings for DB
const safeString = (str, maxLength = 1000) => 
  str ? String(str).slice(0, maxLength).replace(/\0/g, '') : null;

export default async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');
  const client = new Client(DB_CONFIG);
  
  try {
    // 1. Process sandbox activation
    const userMessage = safeString(req.body.Body);
    if (userMessage?.toLowerCase().startsWith('join')) {
      twiml.message("🚀 You're connected! Ask us anything anytime.");
      return res.send(twiml.toString());
    }

    // 2. Clean and validate numbers
    const fromNumber = safeString(req.body.From, 50);
    const toNumber = safeString(req.body.To, 50);
    const cleanNumber = toNumber.replace('whatsapp:', '');
    const isSandbox = SANDBOX_NUMBERS.has(toNumber) || SANDBOX_NUMBERS.has(cleanNumber);

    // 3. Get business config
    let config = {
      business_name: 'Our Business',
      location: 'our location',
      language: 'English',
      operating_hours: null,
      qa_pairs: {}
    };

    if (!isSandbox) {
      const { rows } = await client.query(
        `SELECT business_name, location, language, 
                operating_hours, qa_pairs
         FROM business_configs
         WHERE $1 = ANY(linked_numbers) OR whatsapp_number = $1
         LIMIT 1`,
        [cleanNumber]
      );
      if (rows[0]) config = rows[0];
    }

    // 4. Generate AI response
    const aiResponse = await getAIResponse(
      userMessage,
      {
        businessName: config.business_name,
        location: config.location,
        knownAnswers: config.qa_pairs || {},
        operatingHours: config.operating_hours
      },
      config.language || 'English'
    );

    // 5. Log interaction (NEW)
    await client.query(
      `INSERT INTO message_logs (
        business_number, customer_number,
        message, response, 
        is_answered, language
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        cleanNumber,
        fromNumber,
        userMessage,
        safeString(aiResponse),
        aiResponse !== "I'll check and respond shortly",
        config.language || 'English'
      ]
    );

    // 6. Send response
    twiml.message(safeString(aiResponse));
    res.send(twiml.toString());

  } catch (error) {
    console.error("PROCESSING FAILED:", {
      error: error.message,
      timestamp: new Date().toISOString(),
      body: req.body ? JSON.stringify(req.body).slice(0, 200) : null
    });

    // Fallback response
    twiml.message("We're experiencing high demand. Please try again shortly.");
    res.send(twiml.toString());

  } finally {
    try {
      await client.end();
    } catch (dbError) {
      console.error('DB cleanup error:', dbError.message);
    }
  }
};