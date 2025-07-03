import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

const twiml = new twilio.twiml.MessagingResponse();

// List of known sandbox numbers
const SANDBOX_NUMBERS = process.env.TWILIO_SANDBOX_NUMBERS?.split(',') || [
  '+14155238886' // Default Twilio sandbox
];

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

    // 2. FIND BUSINESS CONFIG
    await client.connect();
    
    // Check if this is a sandbox number
    const isSandbox = SANDBOX_NUMBERS.includes(req.body.To);
    
    let query;
    let params;
    
    if (isSandbox) {
      // For sandbox, find any business that has this sandbox linked
      query = `SELECT 
                qa_pairs, business_name, 
                location, language 
              FROM business_configs
              WHERE $1 = ANY(linked_numbers)`;
      params = [req.body.To];
    } else {
      // For real numbers, match either linked_numbers or whatsapp_number
      query = `SELECT 
                qa_pairs, business_name, 
                location, language 
              FROM business_configs
              WHERE $1 = ANY(linked_numbers) OR whatsapp_number = $1`;
      params = [req.body.To];
    }

    const { rows } = await client.query(query, params);

    if (rows.length === 0) {
      console.error('Business lookup failed for:', {
        to: req.body.To,
        isSandbox,
        availableNumbers: (await client.query('SELECT whatsapp_number FROM business_configs LIMIT 5')).rows
      });
      throw new Error("Business not found for this number");
    }
    
    const config = rows[0];

    // 3. GENERATE AI RESPONSE
    const aiResponse = await getAIResponse(
      req.body.Body,
      {
        businessName: config.business_name,
        location: config.location,
        knownAnswers: config.qa_pairs || {}
      },
      config.language || 'English'
    );

    // 4. SEND REPLY
    twiml.message(aiResponse);
    res.send(twiml.toString());

    // 5. LOG MESSAGE
    await client.query(
      `INSERT INTO messages 
       (user_number, business_number, message, response, is_sandbox)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.body.From, req.body.To, req.body.Body, aiResponse, isSandbox]
    );

  } catch (error) {
    console.error("Error processing message:", error.message);
    
    // Friendly error response
    twiml.message("We're here to help! Please try again in a moment.");
    res.send(twiml.toString());
    
  } finally {
    await client.end();
  }
};