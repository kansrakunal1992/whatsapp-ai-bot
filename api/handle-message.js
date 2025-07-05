import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

const twiml = new twilio.twiml.MessagingResponse();

// Constants
const SANDBOX_NUMBERS = [
  'whatsapp:+14155238886',
  '+14155238886',
  ...(process.env.TWILIO_SANDBOX_NUMBERS?.split(',') || [])
].map(num => num.trim());

// Configuration
const DB_CONFIG = {
  connectionString: process.env.DATABASE_URL,
  idleTimeoutMillis: 5000,
  max: 5 // Connection pool size
};

// Safe string truncation
const safeString = (str, maxLength) => 
  str ? String(str).slice(0, maxLength) : null;

export default async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');
  const client = new Client(DB_CONFIG);
  let responseSent = false;

  try {
    // 1. SANDBOX ACTIVATION
    const userMessage = req.body.Body?.trim().toLowerCase() || '';
    if (userMessage.startsWith('join')) {
      if (!responseSent) {
        responseSent = true;
        twiml.message("🚀 You're connected! Ask us anything anytime.");
        return res.send(twiml.toString());
      }
      return;
    }

    // 2. SANDBOX DETECTION AND NUMBER CLEANING
    const incomingNumber = req.body.To || '';
    const cleanNumber = incomingNumber.replace('whatsapp:', '');
    const isSandbox = SANDBOX_NUMBERS.some(num => 
      num === incomingNumber || num === cleanNumber
    );

    console.log('Processing message:', {
      from: safeString(req.body.From, 50),
      to: safeString(cleanNumber, 50),
      messageId: safeString(req.body.MessageSid, 34),
      bodyPreview: safeString(req.body.Body, 100)
    });

    // 3. DUPLICATE CHECK
    await client.connect();
    const messageId = safeString(req.body.MessageSid || req.body.SmsSid, 34);
    
    if (messageId) {
      const { rows: [existing] } = await client.query(
        `SELECT 1 FROM messages WHERE message_id = $1 LIMIT 1`,
        [messageId]
      );
      if (existing) {
        console.log('Duplicate detected - skipping:', messageId);
        if (!responseSent) {
          responseSent = true;
          return res.send(twiml.toString()); // Empty response
        }
        return;
      }
    }

    // 4. BUSINESS CONFIG LOOKUP
    const { rows } = await client.query(
      `SELECT 
        qa_pairs, business_name, 
        location, language 
       FROM business_configs
       WHERE $1 = ANY(linked_numbers) OR whatsapp_number = $1
       LIMIT 1`,
      [cleanNumber]
    );
    const config = rows[0];

    if (!config) {
      throw new Error(`No business config found for number: ${cleanNumber}`);
    }

    // 5. GENERATE AI RESPONSE
    const aiResponse = await getAIResponse(
      safeString(req.body.Body, 1000),
      {
        businessName: config.business_name,
        location: config.location,
        knownAnswers: config.qa_pairs || {}
      },
      config.language || 'English'
    );

    // 6. SEND REPLY (Single-response guarantee)
    if (!responseSent) {
      responseSent = true;
      twiml.message(safeString(aiResponse, 1000));
      res.send(twiml.toString());
    }

    // 7. DATABASE LOGGING WITH PROPER NUMBER FORMATTING
    await client.query(
      `INSERT INTO messages (
        user_number, business_number,
        message, response,
        is_sandbox, message_id,
        created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        safeString(req.body.From, 50),
        cleanNumber, // Using the cleaned number
        safeString(req.body.Body, 1000),
        safeString(aiResponse, 1000),
        isSandbox,
        messageId
      ]
    );

    console.log('Message logged successfully:', {
      messageId,
      businessNumber: cleanNumber,
      isSandbox
    });

  } catch (error) {
    console.error("PROCESSING FAILED:", {
      error: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join(' | '),
      body: {
        from: safeString(req.body.From, 50),
        to: safeString(req.body.To, 50),
        messageId: safeString(req.body.MessageSid, 34)
      }
    });

    if (!responseSent) {
      responseSent = true;
      twiml.message("We're upgrading our system. Please message again in 5 minutes.");
      res.send(twiml.toString());
    }

  } finally {
    try {
      await client.end();
    } catch (dbError) {
      console.error('DB connection cleanup failed:', dbError.message);
    }
  }
};