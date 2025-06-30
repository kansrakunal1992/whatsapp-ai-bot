import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

// Initialize Twilio client with environment variables
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export default async (req, res) => {
  // Set response type for Twilio
  res.setHeader('Content-Type', 'text/xml');
  const twiml = new twilio.twiml.MessagingResponse();
  const client = new Client(process.env.DATABASE_URL);

  try {
    // Validate Twilio request signature
    if (process.env.NODE_ENV === 'production') {
      const signature = req.headers['x-twilio-signature'];
      const url = `${process.env.BASE_URL}/api/handle-message`;
      const params = req.body;
      
      if (!twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN,
        signature,
        url,
        params
      )) {
        console.error('Invalid Twilio signature detected');
        throw new Error("Invalid request signature");
      }
    }

    // Process incoming message
    const userNumber = req.body.From;
    const userMessage = req.body.Body.trim();
    const cleanNumber = userNumber.replace(/\D/g, '').slice(-10); // Keep last 10 digits
    const lowerUserMessage = userMessage.toLowerCase();

    await client.connect();

    // Check message count and rate limiting
    const countResult = await client.query(
      `INSERT INTO message_counts (user_number, count, last_message_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (user_number) 
       DO UPDATE SET 
         count = message_counts.count + 1,
         last_message_at = NOW()
       RETURNING count`,
      [cleanNumber]
    );

    const messageCount = countResult.rows[0]?.count || 0;

    // Free tier message limit (30 messages)
    if (messageCount > 30) {
      twiml.message("🚫 Free trial limit reached (30/30 messages). Please upgrade to continue.");
      return res.send(twiml.toString());
    }

    // Rate limiting (5 messages per minute)
    const rateCheck = await client.query(
      `SELECT COUNT(*) FROM messages 
       WHERE user_number = $1 AND created_at > NOW() - INTERVAL '1 minute'`,
      [cleanNumber]
    );

    if (rateCheck.rows[0]?.count > 5) {
      twiml.message("⚠️ Too many requests. Please wait a minute before sending more messages.");
      return res.send(twiml.toString());
    }

    // Get business configuration
    const { rows } = await client.query(
      `SELECT 
         qa_pairs, 
         operating_hours, 
         business_name, 
         language, 
         location, 
         whatsapp_number,
         is_pro_account
       FROM business_configs 
       WHERE whatsapp_number = $1`,
      [userNumber]
    );

    if (rows.length === 0) {
      console.error('No business config found for:', userNumber);
      twiml.message("🔍 No business configuration found. Please complete setup.");
      return res.send(twiml.toString());
    }

    const config = rows[0];
    const { qa_pairs: qaPairs, language = 'English', is_pro_account: isProAccount } = config;

    // Check business hours for non-pro accounts
    if (!isProAccount) {
      const now = new Date();
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const currentTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
      
      if (config.operating_hours) {
        const { opening, closing } = config.operating_hours;
        if (currentTime < opening || currentTime > closing) {
          twiml.message(`⏳ We're currently closed. Our hours are ${opening} to ${closing}.`);
          return res.send(twiml.toString());
        }
      }
    }

    // Try to find answer in Q&A pairs (case insensitive)
    let response = null;
    const normalizedQAPairs = {};
    
    if (qaPairs) {
      for (const [question, answer] of Object.entries(qaPairs)) {
        normalizedQAPairs[question.toLowerCase()] = answer;
      }
      
      response = normalizedQAPairs[lowerUserMessage] || 
                 Object.entries(normalizedQAPairs).find(([q]) => 
                   lowerUserMessage.includes(q)
                 )?.[1];
    }

    // Use AI if no match found
    if (!response) {
      const businessContext = {
        businessName: config.business_name,
        operatingHours: config.operating_hours,
        location: config.location,
        knownAnswers: qaPairs || {},
        isProAccount
      };

      response = await getAIResponse(
        userMessage,
        businessContext,
        language
      ) || (language === 'hi' 
        ? "Kripya thodi der baad phir se koshish karein." 
        : "Please try again later.");
      
      // Log unanswered questions for improvement
      await client.query(
        `INSERT INTO unanswered_questions 
         (whatsapp_number, user_number, question, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [config.whatsapp_number, cleanNumber, userMessage]
      );
    }

    // Log the message
    await client.query(
      `INSERT INTO messages 
       (whatsapp_number, user_number, message, response, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [config.whatsapp_number, cleanNumber, userMessage, response]
    );

    // Send response
    twiml.message(response);
    return res.send(twiml.toString());

  } catch (error) {
    console.error('Error handling message:', {
      error: error.message,
      timestamp: new Date().toISOString(),
      path: '/api/handle-message'
    });
    
    twiml.message("⚠️ We're experiencing high demand. Please try again later.");
    return res.send(twiml.toString());
  } finally {
    await client.end();
  }
};
