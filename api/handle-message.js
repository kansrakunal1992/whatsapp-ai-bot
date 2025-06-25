import twilio from 'twilio';
import { buffer } from 'micro';
import querystring from 'querystring';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Mock database
const getFromDatabase = async (userNumber) => ({
  businessInfo: { name: "SmartBiz Solutions", language: "English" },
  qaPairs: {
    "hi": "Hello! How can I assist you today?",
    "hours": "We are open from 9 AM to 6 PM.",
    "location": "We are located in Gurugram.",
  }
});

export default async (req, res) => {
  try {
    const rawBody = await buffer(req);
    const parsedBody = querystring.parse(rawBody.toString());

    const twilioSignature = req.headers['x-twilio-signature'];
    const url = 'https://whatsapp-ai-bot-1ox3-git-main-kunal-kansras-projects.vercel.app/api/handle-message';

    const isValid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      twilioSignature,
      url,
      parsedBody
    );

    if (!isValid) return res.status(403).send('Invalid signature');

    const userNumber = parsedBody.From;
    const userMessage = parsedBody.Body?.trim().toLowerCase();

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
        { role: "system", content: `You are a WhatsApp AI assistant for ${businessInfo.name}. Answer in ${businessInfo.language}.` },
        { role: "user", content: parsedBody.Body }
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
    const reply = aiResponse?.choices?.[0]?.message?.content || "Sorry, I couldn't understand that.";

    twiml.message(reply);
    res.type('text/xml').send(twiml.toString());

  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("Server error");
  }
};
