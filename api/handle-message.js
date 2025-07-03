import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

const twiml = new twilio.twiml.MessagingResponse();

// Improved sandbox detection
const SANDBOX_NUMBERS = [
  'whatsapp:+14155238886', // Twilio sandbox format
  '+14155238886',          // Without prefix
  ...(process.env.TWILIO_SANDBOX_NUMBERS?.split(',') || [])
].map(num => num.trim());

export default async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');
  const client = new Client(process.env.DATABASE_URL);

  try {
    // 1. SANDBOX ACTIVATION
    const userMessage = req.body.Body.trim().toLowerCase();
    if (userMessage.startsWith('join')) {
      twiml.message("🚀 You're connected! Ask us anything anytime.");
      return res.send(twiml.toString());
    }

    // 2. IMPROVED SANDBOX DETECTION
    const incomingNumber = req.body.To;
    const cleanNumber = incomingNumber.replace('whatsapp:', '');
    const isSandbox = SANDBOX_NUMBERS.some(num => 
      num === incomingNumber || num === cleanNumber
    );

    console.log('Incoming message details:', {
      to: incomingNumber,
      cleanNumber,
      isSandbox,
      recognizedSandboxNumbers: SANDBOX_NUMBERS
    });

    // 3. FIND BUSINESS CONFIG
    await client.connect();
    
    let config;
    if (isSandbox) {
      // Sandbox-specific lookup
      const { rows } = await client.query(
        `SELECT 
          qa_pairs, business_name, 
          location, language 
         FROM business_configs
         WHERE $1 = ANY(linked_numbers)
         LIMIT 1`,
        [cleanNumber]
      );
      
      if (rows.length > 0) {
        config = rows[0];
      } else {
        // Fallback: Get the first business config if no direct link
        const { rows } = await client.query(
          `SELECT 
            qa_pairs, business_name, 
            location, language 
           FROM business_configs
           LIMIT 1`
        );
        config = rows[0];
      }
    } else {
      // Production number lookup
      const { rows } = await client.query(
        `SELECT 
          qa_pairs, business_name, 
          location, language 
         FROM business_configs
         WHERE $1 = ANY(linked_numbers) OR whatsapp_number = $1
         LIMIT 1`,
        [cleanNumber]
      );
      config = rows[0];
    }

    if (!config) {
      throw new Error("No business configuration found");
    }

    // 4. GENERATE AI RESPONSE
    const aiResponse = await getAIResponse(
      req.body.Body,
      {
        businessName: config.business_name,
        location: config.location,
        knownAnswers: config.qa_pairs || {}
      },
      config.language || 'English'
    );

    // 5. SEND REPLY
    twiml.message(aiResponse);
    res.send(twiml.toString());

    // 6. LOG MESSAGE
    await client.query(
      `INSERT INTO messages 
       (user_number, business_number, message, response, is_sandbox)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.body.From, req.body.To, req.body.Body, aiResponse, isSandbox]
    );

  } catch (error) {
    console.error("Error processing message:", {
      error: error.message,
      stack: error.stack,
      body: req.body
    });
    
    twiml.message("We're experiencing high demand. Please try again later.");
    res.send(twiml.toString());
    
  } finally {
    await client.end();
  }
};