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
    
    // Extract last 10 digits (handles +91, 91, 0 prefixes)
    const cleanNumber = userNumber.replace(/\D/g, '').slice(-10);
    
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

    // 5. Get business config - matches last 10 digits
    const configResult = await neonClient.query(`
      SELECT qa_pairs, operating_hours 
      FROM business_configs 
      WHERE RIGHT(whatsapp_number, 10) = $1
    `, [cleanNumber]);

    console.log("----- DEBUG START -----");
    console.log("QUERY PARAM:", cleanNumber);
    console.log("QUERY RESULTS:", JSON.stringify(configResult.rows, null, 2));
    
    if (configResult.rows.length > 0) {
      const config = configResult.rows[0];
      
      // 6. Check Q&A pairs
      if (config.qa_pairs) {
        console.log("AVAILABLE QA KEYS:", Object.keys(config.qa_pairs));
        
        // 7. Case-insensitive matching
        const lowerUserMessage = userMessage.toLowerCase();
        const qaPairsLower = Object.fromEntries(
          Object.entries(config.qa_pairs).map(([k, v]) => [k.toLowerCase(), v])
        );

        // Try exact match first
        if (qaPairsLower[lowerUserMessage]) {
          console.log("EXACT MATCH FOUND");
          twiml.message(config.qa_pairs[userMessage] || qaPairsLower[lowerUserMessage]);
          return res.send(twiml.toString());
        }

        // Try partial match if exact fails
        const partialMatchKey = Object.keys(qaPairsLower).find(key => 
          lowerUserMessage.includes(key)
        );
        if (partialMatchKey) {
          console.log("PARTIAL MATCH FOUND:", partialMatchKey);
          twiml.message(config.qa_pairs[partialMatchKey] || qaPairsLower[partialMatchKey]);
          return res.send(twiml.toString());
        }
      }
    }
    console.log("----- DEBUG END -----");

    // 8. Default responses
    const defaultResponses = {
      'hi': 'Hello! Thanks for messaging us.',
      'hello': 'Hello! How can I help?',
      'help': 'Type your question and we\'ll assist you.',
      'default': "Thank you for your message. We'll respond soon."
    };
    
    twiml.message(defaultResponses[userMessage.toLowerCase()] || defaultResponses.default);

  } catch (error) {
    console.error('Error:', error);
    twiml.message("⚠️ Temporary system issue. Please try again.");
  } finally {
    if (neonClient) await neonClient.end().catch(console.error);
  }

  return res.send(twiml.toString());
};