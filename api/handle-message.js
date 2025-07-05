import { Pool } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

// Initialize Twilio with proper error handling
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Enhanced database pool configuration
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  idleTimeoutMillis: 30000,
  max: 5,
  allowExitOnIdle: true
});

// Sandbox configuration with fallbacks
const SANDBOX_NUMBERS = new Set([
  process.env.TWILIO_PHONE_NUMBER,
  'whatsapp:+14155238886', // Default Twilio sandbox
  ...(process.env.TWILIO_SANDBOX_NUMBERS?.split(',') || [])
].map(num => num.trim()).filter(num => num));

// Track pending messages to prevent duplicates
const pendingMessages = new Set();

export default async (req, res) => {
  // 1. Generate unique message ID for tracking
  const messageId = req.body.MessageSid || `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  
  // 2. Immediate response to Twilio
  const initialTwiml = new twilio.twiml.MessagingResponse();
  initialTwiml.message("We're processing your request...");
  res.setHeader('Content-Type', 'text/xml');
  res.send(initialTwiml.toString());

  // 3. Check for duplicate processing
  if (pendingMessages.has(messageId)) {
    console.log(`Duplicate message ${messageId} detected`);
    return;
  }
  pendingMessages.add(messageId);

  try {
    const { Body, From, To } = req.body;
    const userMessage = String(Body || '').slice(0, 1000);
    const fromNumber = String(From || '').slice(0, 50);
    const toNumber = String(To || '').slice(0, 50);
    const isSandbox = SANDBOX_NUMBERS.has(toNumber.replace('whatsapp:', ''));

    // 4. Process sandbox activation
    if (isSandbox && userMessage.toLowerCase().startsWith('join')) {
      await sendWithRetry(fromNumber, toNumber, "🚀 You're connected! Ask us anything anytime.");
      return;
    }

    // 5. Get business config with timeout
    const config = await Promise.race([
      getBusinessConfig(toNumber),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Business config timeout')), 5000)
    ]);

    // 6. Generate AI response with timeout
    const aiResponse = await Promise.race([
      getAIResponse(userMessage, {
        businessName: config.business_name,
        knownAnswers: config.qa_pairs || {},
        apiKey: process.env.DEEPSEEK_API_KEY
      }, config.language || 'English'),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('AI response timeout')), 10000)
    ]);

    // 7. Store message (fire-and-forget)
    dbPool.query(
      `INSERT INTO message_logs (...) VALUES (...)`,
      [toNumber, fromNumber, userMessage, aiResponse]
    ).catch(console.error);

    // 8. Send final response with retry logic
    await sendWithRetry(fromNumber, toNumber, aiResponse);

  } catch (error) {
    console.error("Processing failed:", error);
    
    // 9. Fallback error message
    await sendWithRetry(
      req.body.From, 
      req.body.To,
      "We're experiencing high demand. Please try again later."
    );
    
    // 10. Critical error notification
    if (process.env.TWILIO_PHONE_NUMBER) {
      await twilioClient.messages.create({
        body: `CRITICAL: ${error.message.slice(0, 100)}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: process.env.TWILIO_PHONE_NUMBER
      }).catch(e => console.error("Failed to send alert:", e));
    }
  } finally {
    pendingMessages.delete(messageId);
  }
};

// Enhanced send function with retry logic
async function sendWithRetry(to, from, body, attempt = 1) {
  try {
    await twilioClient.messages.create({
      body: String(body).slice(0, 1600),
      from: from,
      to: to
    });
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    return sendWithRetry(to, from, body, attempt + 1);
  }
}

// Business config with caching
const configCache = new Map();
async function getBusinessConfig(number) {
  if (configCache.has(number)) {
    return configCache.get(number);
  }

  const { rows } = await dbPool.query(`
    SELECT * FROM business_configs 
    WHERE $1 = ANY(linked_numbers) 
    LIMIT 1
  `, [number.replace('whatsapp:', '')]);

  const config = rows[0] || {
    business_name: 'Our Business',
    language: 'English',
    qa_pairs: {}
  };

  configCache.set(number, config);
  setTimeout(() => configCache.delete(number), 300000); // 5 min cache

  return config;
}