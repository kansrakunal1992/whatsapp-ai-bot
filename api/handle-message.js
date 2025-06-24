import twilio from 'twilio';

export default async (req, res) => {
  // 1. Validate Twilio request (same as before)
  const twilioSignature = req.headers['x-twilio-signature'];
  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    'https://your-vercel-url.vercel.app/api/handle-message',
    req.body
  );
  if (!isValid) return res.status(403).send('Invalid signature');

  // 2. Load user’s custom Q&A (same as before)
  const userNumber = req.body.From;
  const { qaPairs, businessInfo } = await getFromDatabase(userNumber);

  // 3. Check for exact match in custom Q&A (same as before)
  const userMessage = req.body.Body.trim().toLowerCase();
  const customAnswer = Object.entries(qaPairs).find(([q]) => 
    q.toLowerCase() === userMessage
  )?.[1];

  if (customAnswer) {
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(customAnswer);
    return res.type('text/xml').send(twiml.toString());
  }

  // 4. Use Deepseek for dynamic responses (CHANGED)
  const prompt = {
    model: "deepseek-chat",
    messages: [
      { 
        role: "system", 
        content: `You are a WhatsApp AI assistant for ${businessInfo.name}. Answer in ${businessInfo.language}.` 
      },
      { 
        role: "user", 
        content: req.body.Body 
      }
    ],
    temperature: 0.7
  };

  const deepseekResponse = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify(prompt)
  });

  const aiResponse = await deepseekResponse.json();

  // 5. Send response (same as before)
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(aiResponse.choices[0].message.content);
  res.type('text/xml').send(twiml.toString());
};