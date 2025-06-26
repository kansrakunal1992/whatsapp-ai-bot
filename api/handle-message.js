import twilio from 'twilio';

export default async (req, res) => {
  // 1. Set response headers
  res.setHeader('Content-Type', 'text/xml');
  
  // 2. Initialize Twilio response
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    // 3. Validate Twilio request (optional but recommended)
    const twilioSignature = req.headers['x-twilio-signature'];
    const url = 'https://whatsapp-ai-bot-1ox3.vercel.app/api/handle-message';
    
    if (process.env.TWILIO_AUTH_TOKEN) {
      const isValid = twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN,
        twilioSignature,
        url,
        req.body
      );
      if (!isValid) {
        console.error("Invalid Twilio signature");
        twiml.message("Error: Invalid request");
        return res.send(twiml.toString());
      }
    }

    // 4. Get user message and number
    const userMessage = req.body.Body.trim().toLowerCase();
    const userNumber = req.body.From;

    console.log(`Message from ${userNumber}: "${userMessage}"`);

    // 5. Simple hardcoded responses
    const responses = {
      'hi': 'Hello! Thanks for messaging us.',
      'hello': 'Hello! Thanks for messaging us.',
      'hours': 'Our working hours are 9 AM to 6 PM.',
      'location': 'We are located in Bangalore, India.',
      'default': `We received your message: "${userMessage}". This is a test response.`
    };

    // 6. Send reply
    const reply = responses[userMessage] || responses.default;
    twiml.message(reply);

    console.log(`Replying to ${userNumber}: "${reply}"`);

  } catch (error) {
    console.error("Error:", error);
    twiml.message("Sorry, we're experiencing technical difficulties.");
  }

  // 7. Send final response
  return res.send(twiml.toString());
};