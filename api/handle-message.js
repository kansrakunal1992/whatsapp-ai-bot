import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';

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

    console.log(`Message from ${userNumber} (clean: ${cleanNumber}): "${userMessage}"`);

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

    // 5. Get ALL matching configs
    const configResults = await neonClient.query(`
      SELECT qa_pairs, operating_hours, language 
      FROM business_configs 
      WHERE RIGHT(whatsapp_number, 10) = $1
    `, [cleanNumber]);

    console.log("----- DEBUG START -----");
    console.log("FOUND CONFIGS:", configResults.rows.length);

    // 6. Detect language from message (if language column exists)
    const detectedLang = /[\u0980-\u09FF]/.test(userMessage) ? 'bn' : 
                        /[\u0C00-\u0C7F]/.test(userMessage) ? 'te' : 
                        'en';

    // 7. Search through configurations
    let matchedResponse = null;
    let usedLanguage = null;

    for (const config of configResults.rows) {
      if (!config.qa_pairs) continue;

      // Prioritize configs with matching language
      if (config.language && config.language !== detectedLang) continue;

      // Exact match check
      for (const [question, answer] of Object.entries(config.qa_pairs)) {
        if (question.toLowerCase() === lowerUserMessage) {
          matchedResponse = answer;
          usedLanguage = config.language || 'detected';
          break;
        }
      }
      if (matchedResponse) break;

      // Partial match check
      for (const [question, answer] of Object.entries(config.qa_pairs)) {
        if (lowerUserMessage.includes(question.toLowerCase())) {
          matchedResponse = answer;
          usedLanguage = config.language || 'detected';
          break;
        }
      }
      if (matchedResponse) break;
    }

    console.log("MATCH DETAILS:", {
      input: userMessage,
      matched: matchedResponse ? true : false,
      language: usedLanguage
    });
    console.log("----- DEBUG END -----");

    if (matchedResponse) {
      twiml.message(matchedResponse);
      return res.send(twiml.toString());
    }

    // 8. Default responses
    const defaultResponses = {
      'hi': 'Hello! Thanks for messaging us.',
      'hello': 'Hello! How can I help?',
      'help': 'Type your question and we\'ll assist you.',
      'default': "Thank you for your message. We'll respond soon."
    };
    
    twiml.message(defaultResponses[lowerUserMessage] || defaultResponses.default);

  } catch (error) {
    console.error('Error:', error);
    twiml.message("⚠️ Temporary system issue. Please try again.");
  } finally {
    if (neonClient) await neonClient.end().catch(console.error);
  }

  return res.send(twiml.toString());
};