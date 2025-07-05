import { Pool } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

// Initialize Twilio with all required env vars
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Database connection pool using Neon's recommended URL
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL || 
                  process.env.POSTGRES_URL ||
                  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.PGHOST}/${process.env.POSTGRES_DATABASE}`
});

// Configure sandbox numbers
const SANDBOX_NUMBERS = new Set([
  process.env.TWILIO_PHONE_NUMBER,
  ...(process.env.TWILIO_SANDBOX_NUMBERS?.split(',') || [])
].filter(Boolean).map(num => num.trim()));

// Helper functions
const safeString = (str, maxLength = 1000) => 
  str ? String(str).slice(0, maxLength).replace(/\0/g, '') : null;

const normalizeNumber = (num) => num.replace('whatsapp:', '').toLowerCase();

export default async (req, res) => {
  // 1. Immediate response to prevent Twilio timeout
  const initialTwiml = new twilio.twiml.MessagingResponse();
  initialTwiml.message("We're processing your message...");
  res.setHeader('Content-Type', 'text/xml');
  res.send(initialTwiml.toString());

  try {
    // 2. Process message in background
    const { Body, From, To } = req.body;
    const userMessage = safeString(Body);
    const fromNumber = safeString(From, 50);
    const toNumber = safeString(To, 50);
    const cleanNumber = normalizeNumber(toNumber);
    const isSandbox = SANDBOX_NUMBERS.has(normalizeNumber(toNumber));

    // 3. Handle sandbox activation
    if (isSandbox && userMessage?.toLowerCase().startsWith('join')) {
      await sendWhatsAppMessage(
        fromNumber,
        toNumber,
        "🚀 You're connected! Ask us anything anytime."
      );
      return;
    }

    // 4. Get business config using Neon project as identifier
    const config = await getBusinessConfig(
      process.env.NEON_PROJECT_ID || 
      process.env.NEXT_PUBLIC_STACK_PROJECT_ID
    );

    // 5. Generate AI response with Deepseek
    const aiResponse = await getAIResponse(
      userMessage,
      {
        businessName: config.business_name,
        location: config.location,
        knownAnswers: config.qa_pairs || {},
        operatingHours: config.operating_hours,
        apiKey: process.env.DEEPSEEK_API_KEY
      },
      config.language || 'English'
    );

    // 6. Log interaction using pooled connection
    await logMessage(
      process.env.NEON_PROJECT_ID,
      fromNumber,
      userMessage,
      aiResponse,
      config.language
    );

    // 7. Send response via Twilio
    await sendWhatsAppMessage(fromNumber, toNumber, aiResponse);

  } catch (error) {
    console.error("Background processing failed:", {
      error: error.message,
      timestamp: new Date().toISOString(),
      body: req.body ? safeString(JSON.stringify(req.body), 200) : null
    });

    // Optional admin alert using Twilio
    if (process.env.TWILIO_PHONE_NUMBER) {
      await sendWhatsAppMessage(
        process.env.TWILIO_PHONE_NUMBER,
        process.env.TWILIO_PHONE_NUMBER,
        `⚠️ Error: ${safeString(error.message, 100)}`
      );
    }
  }
};

// Helper: Get business configuration
async function getBusinessConfig(businessId) {
  const { rows } = await dbPool.query(
    `SELECT business_name, location, language, 
            operating_hours, qa_pairs
     FROM business_configs
     WHERE business_id = $1
     LIMIT 1`,
    [businessId]
  );

  return rows[0] || {
    business_name: 'Our Business',
    location: 'our location',
    language: 'English',
    operating_hours: null,
    qa_pairs: {}
  };
}

// Helper: Log message to database
async function logMessage(businessId, customerNumber, message, response, language) {
  return dbPool.query(
    `INSERT INTO message_logs (
      business_id, customer_number,
      message, response, language,
      is_answered
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      businessId,
      customerNumber,
      message,
      safeString(response),
      language,
      response !== "I'll check and respond shortly"
    ]
  ).catch(err => console.error("DB logging failed:", err));
}

// Helper: Send WhatsApp message
async function sendWhatsAppMessage(to, from, body) {
  return twilioClient.messages.create({
    body: safeString(body, 1600), // WhatsApp message limit
    from: from,
    to: to
  }).catch(err => console.error("Twilio send failed:", err));
}