import twilio from 'twilio';

const saveToDatabase = async (id, data) => {
  console.log("Mock save:", id, data);
  return true;
};

export default async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

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

    // Fallback to sandbox if no Twilio credentials
    if (!process.env.TWILIO_SID || !process.env.TWILIO_AUTH_TOKEN) {
      return res.json({
        success: true,
        whatsappNumber: '+14155238886',
        isSandbox: true,
        warning: "Twilio credentials missing — using sandbox"
      });
    }

    const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
    const webhookUrl = process.env.BASE_URL 
      ? `${process.env.BASE_URL}/api/handle-message`
      : 'https://whatsapp-ai-bot-1ox3.vercel.app/api/handle-message';

    if (process.env.TWILIO_SERVICE_SID) {
      await client.messaging.v1.services(process.env.TWILIO_SERVICE_SID)
        .update({ inboundRequestUrl: webhookUrl });
      console.log("Twilio webhook configured:", webhookUrl);
    }

    res.json({
      success: true,
      whatsappNumber: process.env.TWILIO_PHONE_NUMBER || '+14155238886',
      isSandbox: !process.env.TWILIO_PHONE_NUMBER
    });

  } catch (error) {
    console.error("Deployment failed:", error);
    res.status(500).json({
      error: error.message || 'Internal server error',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
