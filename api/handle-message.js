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
    `, [userNumber]);

    if (countResult.rows[0].count > 30) {
      twiml.message("🚫 Free trial limit reached (30/30). Please upgrade.");
      return res.send(twiml.toString());
    }

    // 5. Get business config (with enhanced debugging)
    const configResult = await neonClient.query(`
      SELECT qa_pairs, operating_hours 
      FROM business_configs 
      WHERE whatsapp_number = $1
    `, [userNumber]);

    console.log("----- DEBUG START -----");
    console.log("QUERY RESULTS:", JSON.stringify(configResult.rows, null, 2));
    
    if (configResult.rows.length > 0) {
      const config = configResult.rows[0];
      
      // 6. Verify Q&A pairs exist
      if (config.qa_pairs) {
        console.log("QA_PAIRS KEYS:", Object.keys(config.qa_pairs));
        
        // 7. Exact match test
        const exactMatch = config.qa_pairs[userMessage];
        console.log("EXACT MATCH TEST:", { 
          input: userMessage, 
          found: exactMatch ? true : false 
        });

        if (exactMatch) {
          twiml.message(exactMatch);
          return res.send(twiml.toString());
        }

        // 8. Case-insensitive match
        const lowerUserMessage = userMessage.toLowerCase();
        const qaPairsLower = Object.fromEntries(
          Object.entries(config.qa_pairs).map(([k, v]) => [k.toLowerCase(), v])
        );
        
        const caseInsensitiveMatch = qaPairsLower[lowerUserMessage];
        console.log("CASE-INSENSITIVE MATCH TEST:", {
          input: lowerUserMessage,
          found: caseInsensitiveMatch ? true : false
        });

        if (caseInsensitiveMatch) {
          twiml.message(caseInsensitiveMatch);
          return res.send(twiml.toString());
        }
      }
    }
    console.log("----- DEBUG END -----");

    // 9. Default responses
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