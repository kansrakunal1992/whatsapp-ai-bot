import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

const twiml = new twilio.twiml.MessagingResponse();

export default async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');
  const client = new Client(process.env.DATABASE_URL);

  try {
    // ================================================
    // 1. SANDBOX ACTIVATION (REQUIRED FOR TESTING)
    // ================================================
    const userMessage = req.body.Body.trim().toLowerCase();
    if (userMessage.startsWith('join')) {
      twiml.message("🚀 You're connected! Ask us anything anytime.");
      return res.send(twiml.toString());
    }

    // ================================================
    // 2. FIND BUSINESS CONFIG
    // ================================================
    await client.connect();
    const { rows } = await client.query(
      `SELECT 
         qa_pairs, business_name, 
         location, language 
       FROM business_configs
       WHERE $1 = ANY(linked_numbers) OR whatsapp_number = $1`,
      [req.body.To] // Works for both sandbox and real numbers
    );

    if (rows.length === 0) {
      throw new Error("Business not found for this number");
    }
    const config = rows[0];

    // ================================================
    // 3. GENERATE 24/7 AI RESPONSE
    // ================================================
    const aiResponse = await getAIResponse(
      req.body.Body,
      {
        businessName: config.business_name,
        location: config.location,
        knownAnswers: config.qa_pairs || {}
      },
      config.language || 'English'
    );

    // ================================================
    // 4. SEND INSTANT REPLY
    // ================================================
    twiml.message(aiResponse);
    res.send(twiml.toString());

    // ================================================
    // 5. LOG MESSAGE (OPTIONAL ANALYTICS)
    // ================================================
    await client.query(
      `INSERT INTO messages 
       (user_number, business_number, message, response)
       VALUES ($1, $2, $3, $4)`,
      [req.body.From, req.body.To, req.body.Body, aiResponse]
    );

  } catch (error) {
    console.error("Error processing message:", error.message);
    
    // Friendly 24/7 error response
    twiml.message("We're here to help! Please try again in a moment.");
    res.send(twiml.toString());
    
  } finally {
    await client.end();
  }
};