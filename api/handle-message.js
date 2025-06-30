import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

export default async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');
  const twiml = new twilio.twiml.MessagingResponse();
  const client = new Client(process.env.DATABASE_URL);

  try {
    // Validate Twilio request
    if (process.env.TWILIO_AUTH_TOKEN) {
      const signature = req.headers['x-twilio-signature'];
      const url = `${process.env.BASE_URL}/api/handle-message`;
      const params = req.body;
      
      if (!twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN,
        signature,
        url,
        params
      )) {
        throw new Error("Invalid Twilio signature");
      }
    }

    // Process incoming message
    const userNumber = req.body.From;
    const userMessage = req.body.Body.trim();
    const cleanNumber = userNumber.replace(/\D/g, '').slice(-10);
    const lowerUserMessage = userMessage.toLowerCase();

    await client.connect();

    // Check message count
    const countResult = await client.query(
      `INSERT INTO message_counts (user_number, count)
       VALUES ($1, 1)
       ON CONFLICT (user_number) 
       DO UPDATE SET count = message_counts.count + 1
       RETURNING count`,
      [cleanNumber]
    );

    if (countResult.rows[0].count > 30) {
      twiml.message("🚫 Free trial limit reached (30/30). Please upgrade.");
      return res.send(twiml.toString());
    }

    // Get business config
    const { rows } = await client.query(
      `SELECT qa_pairs, operating_hours, business_name, 
              language, location, whatsapp_number
       FROM business_configs 
       WHERE whatsapp_number = $1`,
      [userNumber]
    );

    if (rows.length === 0) {
      twiml.message("🔍 No business configuration found.");
      return res.send(twiml.toString());
    }

    const config = rows[0];
    const { qa_pairs: qaPairs, language = 'English' } = config;

    // Try to find answer in Q&A pairs
    let response = null;
    if (qaPairs?.[userMessage]) {
      response = qaPairs[userMessage];
    } else if (qaPairs) {
      const qaPairsLower = Object.fromEntries(
        Object.entries(qaPairs).map(([k, v]) => [k.toLowerCase(), v])
      );
      response = qaPairsLower[lowerUserMessage];
    }

    // Use AI if no match found
    if (!response) {
      const businessContext = {
        businessName: config.business_name,
        operatingHours: config.operating_hours,
        location: config.location,
        knownAnswers: qaPairs || {}
      };

      response = await getAIResponse(
        userMessage,
        businessContext,
        language
      ) || "Thank you for your message. We'll respond soon.";

      // Log unanswered questions
      await client.query(
        `INSERT INTO unanswered_questions 
         (whatsapp_number, user_number, question)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [config.whatsapp_number, cleanNumber, userMessage]
      );
    }

    twiml.message(response);
    return res.send(twiml.toString());
  } catch (error) {
    console.error('Error handling message:', error);
    twiml.message("⚠️ We're experiencing high demand. Please try again later.");
    return res.send(twiml.toString());
  } finally {
    await client.end();
  }
};
