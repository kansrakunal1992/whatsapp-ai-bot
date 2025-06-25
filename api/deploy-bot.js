import twilio from 'twilio';

const saveToDatabase = async (id, data) => {
  console.log("Mock save:", id, data);
  return true;
};

export default async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  console.log("Request received:", req.method, req.body);

  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { businessInfo, qaPairs } = req.body;

    if (!businessInfo?.whatsappNumber || !qaPairs) {
      return res.status(400).json({
        error: 'Missing businessInfo.whatsappNumber or qaPairs'
      });
    }

    await saveToDatabase(businessInfo.whatsappNumber, { businessInfo, qaPairs });

    if (!process.env.TWILIO_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('Twilio credentials missing');
    }

    const client = twilio(
      process.env.TWILIO_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    if (process.env.TWILIO_SERVICE_SID) {
      await client.messaging.v1.services(process.env.TWILIO_SERVICE_SID)
        .update({
          inboundRequestUrl: 'https://whatsapp-ai-bot-1ox3-git-main-kunal-kansras-projects.vercel.app/api/handle-message',
        });
    } else {
      console.warn("TWILIO_SERVICE_SID not set — skipping webhook update.");
    }

    res.json({
      success: true,
      whatsappNumber: process.env.TWILIO_PHONE_NUMBER || businessInfo.whatsappNumber
    });

  } catch (error) {
    console.error("CRASH:", error);
    res.status(500).json({
      error: error.message || 'Internal server error',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
