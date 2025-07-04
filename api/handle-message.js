import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

const twiml = new twilio.twiml.MessagingResponse();

// Sandbox detection
const SANDBOX_NUMBERS = [
  'whatsapp:+14155238886', // Twilio sandbox
  '+14155238886',
  ...(process.env.TWILIO_SANDBOX_NUMBERS?.split(',') || [])
].map(num => num.trim());

export default async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    idleTimeoutMillis: 5000 // Prevent connection leaks
  });

  try {
    // 1. SANDBOX ACTIVATION
    const userMessage = req.body.Body.trim().toLowerCase();
    if (userMessage.startsWith('join')) {
      twiml.message("🚀 You're connected! Ask us anything anytime.");
      return res.send(twiml.toString());
    }

    // 2. SANDBOX DETECTION
    const incomingNumber = req.body.To;
    const cleanNumber = incomingNumber.replace('whatsapp:', '');
    const isSandbox = SANDBOX_NUMBERS.some(num => 
      num === incomingNumber || num === cleanNumber
    );

    console.log('Incoming message:', {
      from: req.body.From,
      to: cleanNumber,
      body: req.body.Body.substring(0, 50) + (req.body.Body.length > 50 ? '...' : ''),
      isSandbox,
      messageId: req.body.MessageSid
    });

    // 3. DUPLICATE CHECK
    await client.connect();
    const messageId = req.body.MessageSid || req.body.SmsSid;
    
    if (messageId) {
      const { rows: [existing] } = await client.query(
        `SELECT 1 FROM messages WHERE message_id = $1 LIMIT 1`,
        [messageId]
      );
      if (existing) {
        console.log('Duplicate message skipped:', messageId);
        return res.send(twiml.toString());
      }
    }

    // 4. BUSINESS CONFIG
    let config;
    const { rows } = await client.query(
      `SELECT 
        qa_pairs, business_name, location, language 
       FROM business_configs
       WHERE $1 = ANY(linked_numbers) OR whatsapp_number = $1
       LIMIT 1`,
      [cleanNumber]
    );
    config = rows[0];

    if (!config) {
      throw new Error(`No config found for number: ${cleanNumber}`);
    }

    // 5. AI RESPONSE
    const aiResponse = await getAIResponse(
      req.body.Body,
      {
        businessName: config.business_name,
        location: config.location,
        knownAnswers: config.qa_pairs || {}
      },
      config.language || 'English'
    );

    // 6. SEND REPLY
    twiml.message(aiResponse);
    res.send(twiml.toString());

    // 7. LOG MESSAGE (Updated schema)
    await client.query(
      `INSERT INTO messages (
        user_number, business_number, 
        message, response, 
        is_sandbox, message_id
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.body.From,
        req.body.To, // business_number
        req.body.Body,
        aiResponse,
        isSandbox,
        messageId // Unique Twilio ID
      ]
    );

  } catch (error) {
    console.error("ERROR:", {
      error: error.message,
      body: req.body,
      stack: error.stack?.split('\n').slice(0, 3).join('\n')
    });
    
    twiml.message("We're experiencing technical difficulties. Please try again later.");
    res.send(twiml.toString());
    
  } finally {
    await client.end().catch(e => console.error('DB close error:', e));
  }
};