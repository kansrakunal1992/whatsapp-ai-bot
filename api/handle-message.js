import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

export default async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');
  const twiml = new twilio.twiml.MessagingResponse();
  let neonClient;

  try {
    // 1. Validate Twilio request
    if (process.env.TWILIO_AUTH_TOKEN) {
      const isValid = twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN,
        req.headers['x-twilio-signature'],
        `${process.env.BASE_URL}/api/handle-message`,
        req.body
      );
      if (!isValid) throw new Error('Invalid Twilio signature');
    }

    // 2. Process message
    const userNumber = req.body.From;
    const userMessage = req.body.Body.trim();
    const cleanNumber = userNumber.replace(/\D/g, '').slice(-10);
    const lowerUserMessage = userMessage.toLowerCase();

    console.log(`Message from ${userNumber}: "${userMessage}"`);

    // 3. Connect to Neon DB
    neonClient = new Client(process.env.DATABASE_URL);
    await neonClient.connect();

    // 4. Check message count
    const countResult = await neonClient.query(`
      INSERT INTO message_counts (user_number, count)
      VALUES ($1, 1)
      ON CONFLICT (user_number) 
      DO UPDATE SET count = message_counts.count + 1
      RETURNING count
    `, [cleanNumber]);

    if (countResult.rows[0].count > 30) {
      twiml.message("🚫 Free trial limit reached (30/30). Please upgrade.");
      return res.send(twiml.toString());
    }

    // 5. Get business config
    const { rows: configs } = await neonClient.query(`
      SELECT 
        qa_pairs, 
        operating_hours, 
        business_name, 
        language,
        location,
        whatsapp_number
      FROM business_configs 
      WHERE RIGHT(whatsapp_number, 10) = $1
      LIMIT 1
    `, [cleanNumber]);

    if (configs.length === 0) {
      twiml.message("🔍 No business configuration found.");
      return res.send(twiml.toString());
    }

    const config = configs[0];
    const { qa_pairs: qaPairs, language = 'en' } = config;

    // 6. Try to find answer in Q&A pairs first
    let matchedResponse = null;
    
    // Exact match check
    if (qaPairs?.[userMessage]) {
      matchedResponse = qaPairs[userMessage];
    } 
    // Case-insensitive match
    else if (qaPairs) {
      const qaPairsLower = Object.fromEntries(
        Object.entries(qaPairs).map(([k, v]) => [k.toLowerCase(), v])
      );
      matchedResponse = qaPairsLower[lowerUserMessage];
    }

    // 7. If no match found, use Deepseek AI with full context
    if (!matchedResponse) {
      const aiResponse = await getAIResponse(
        userMessage,
        {
          businessName: config.business_name,
          operatingHours: config.operating_hours,
          location: config.location,
          knownAnswers: qaPairs || {},
          language
        },
        language
      );

      matchedResponse = aiResponse || "Thank you for your message. We'll respond soon.";
      
      // Log unanswered questions for review (without blocking response)
      await neonClient.query(`
        INSERT INTO unanswered_questions 
        (whatsapp_number, user_number, question)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
      `, [config.whatsapp_number, cleanNumber, userMessage]);
    }

    twiml.message(matchedResponse);
    return res.send(twiml.toString());

  } catch (error) {
    console.error('Error:', error);
    twiml.message("⚠️ We're experiencing high demand. Please try again later.");
  } finally {
    if (neonClient) await neonClient.end().catch(console.error);
  }

  return res.send(twiml.toString());
};