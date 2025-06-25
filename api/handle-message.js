import twilio from 'twilio';

// Mock database function
const getFromDatabase = async (userNumber) => {
  return {
    businessInfo: {
      name: "SmartBiz Solutions",
      language: "English"
    },
    qaPairs: {
      "hi": "Hello! How can I assist you today?",
      "hours": "We are open from 9 AM to 6 PM, Monday to Saturday.",
      "location": "We are located in Gurugram, Haryana.",
      "appointment": "You can book an appointment by replying with your preferred date and time."
    }
  };
};

export default async (req, res) => {
  // CORS headers (optional for testing)
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Twilio signature validation
  const twilioSignature = req.headers['x-twilio-signature'];
  const url = 'https://whatsapp-ai-bot-1ox3-git-main-kunal-kansras-projects.vercel.app/api/handle-message';

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    url,
    req.body
  );

  if (!isValid) {
    console.error("Invalid Twilio signature");
    return res.status(403).send('Invalid signature');
  }

  const userNumber = req.body.From;
  const userMessage = req.body.Body?.trim().toLowerCase();

  const { qaPairs, businessInfo } = await getFromDatabase(userNumber);

  const customAnswer = Object.entries(qaPairs).find(([q]) =>
    q.toLowerCase() === userMessage
  )?.[1];

  const twiml = new twilio.twiml.MessagingResponse();

  if (customAnswer) {
    twiml.message(customAnswer);
    return res.type('text/xml').send(twiml.toString());
  }

  // Deepseek fallback
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
  twiml.message(aiResponse.choices[0].message.content);
  res.type('text/xml').send(twiml.toString());
};
