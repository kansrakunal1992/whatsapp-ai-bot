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
      SELECT qa_pairs, operating_hours, business_name, language 
      FROM business_configs 
      WHERE RIGHT(whatsapp_number, 10) = $1
    `, [cleanNumber]);

    if (configs.length === 0) {
      twiml.message("Sorry, we couldn't find your business configuration.");
      return res.send(twiml.toString());
    }

    const config = configs[0]; // Using first config for simplicity
    const { qa_pairs: qaPairs, business_name: businessName, language } = config;

    // 6. Try to find answer in Q&A pairs first
    let matchedResponse = null;
    
    // Exact match check (case sensitive)
    if (qaPairs && qaPairs[userMessage]) {
      matchedResponse = qaPairs[userMessage];
    } 
    // Case-insensitive match
    else if (qaPairs) {
      const qaPairsLower = Object.fromEntries(
        Object.entries(qaPairs).map(([k, v]) => [k.toLowerCase(), v])
      );
      if (qaPairsLower[lowerUserMessage]) {
        matchedResponse = qaPairsLower[lowerUserMessage];
      }
      // Partial match check
      else {
        const partialMatchKey = Object.keys(qaPairsLower).find(key => 
          lowerUserMessage.includes(key)
        );
        if (partialMatchKey) {
          matchedResponse = qaPairsLower[partialMatchKey];
        }
      }
    }

    // 7. If no match found, use Deepseek AI
    if (!matchedResponse) {
      // Store the unanswered question first
      await neonClient.query(`
        INSERT INTO unanswered_questions 
        (whatsapp_number, user_number, question)
        VALUES ($1, $2, $3)
      `, [config.whatsapp_number, cleanNumber, userMessage]);

      // Get AI response with business context
      const aiResponse = await getAIResponse(
        userMessage,
        {
          businessName,
          qaPairs,
          operatingHours: config.operating_hours,
          location: config.location
        },
        language || 'en'
      );

      if (aiResponse) {
        // Check if AI response contains factual info we shouldn't know
        const containsFactualInfo = await checkForFactualInfo(userMessage, aiResponse);
        
        if (containsFactualInfo) {
          matchedResponse = `We'll get back to you soon with an answer to your question about ${containsFactualInfo}.`;
        } else {
          matchedResponse = aiResponse;
        }
      } else {
        matchedResponse = "Thank you for your message. We'll respond soon.";
      }
    }

    twiml.message(matchedResponse);
    return res.send(twiml.toString());

  } catch (error) {
    console.error('Error:', error);
    twiml.message("⚠️ Temporary system issue. Please try again.");
  } finally {
    if (neonClient) await neonClient.end().catch(console.error);
  }

  return res.send(twiml.toString());
};

// Helper function to check for factual information in AI response
async function checkForFactualInfo(question, response) {
  // This is a simplified version - you might want to use another AI call
  // to analyze the response for factual information
  
  const factualKeywords = [
    'price', 'cost', 'fee', 'charge', 'rate',
    'specific', 'exact', 'detail', 'precise',
    'address', 'location', 'timing', 'hour'
  ];
  
  const containsFactual = factualKeywords.some(keyword => 
    response.toLowerCase().includes(keyword)
  );
  
  if (containsFactual) {
    // Extract the main topic from the question
    const topic = question.split(' ').slice(0, 5).join(' ');
    return topic.length > 20 ? topic.substring(0, 20) + '...' : topic;
  }
  
  return false;
}