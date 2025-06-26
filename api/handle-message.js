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
    const { rows: configs } = await neonClient.query(`
      SELECT qa_pairs, operating_hours 
      FROM business_configs 
      WHERE RIGHT(whatsapp_number, 10) = $1
    `, [cleanNumber]);

    console.log("----- DEBUG START -----");
    console.log("TOTAL CONFIGS FOUND:", configs.length);

    // 6. Search through ALL configurations
    let matchedResponse = null;
    for (let i = 0; i < configs.length; i++) {
      const config = configs[i];
      if (!config.qa_pairs) continue;

      console.log(`CHECKING CONFIG ${i} WITH KEYS:`, Object.keys(config.qa_pairs));

      // Exact match check (case sensitive)
      if (config.qa_pairs[userMessage]) {
        matchedResponse = config.qa_pairs[userMessage];
        console.log(`EXACT MATCH IN CONFIG ${i}`);
        break;
      }

      // Case-insensitive match
      const qaPairsLower = Object.fromEntries(
        Object.entries(config.qa_pairs).map(([k, v]) => [k.toLowerCase(), v])
      );
      if (qaPairsLower[lowerUserMessage]) {
        matchedResponse = qaPairsLower[lowerUserMessage];
        console.log(`CASE-INSENSITIVE MATCH IN CONFIG ${i}`);
        break;
      }

      // Partial match check
      const partialMatchKey = Object.keys(qaPairsLower).find(key => 
        lowerUserMessage.includes(key)
      );
      if (partialMatchKey) {
        matchedResponse = qaPairsLower[partialMatchKey];
        console.log(`PARTIAL MATCH IN CONFIG ${i}: "${partialMatchKey}"`);
        break;
      }
    }

    console.log("FINAL MATCH RESULT:", matchedResponse || "DEFAULT");
    console.log("----- DEBUG END -----");

    if (matchedResponse) {
      twiml.message(matchedResponse);
      return res.send(twiml.toString());
    }

    // 7. Default responses
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