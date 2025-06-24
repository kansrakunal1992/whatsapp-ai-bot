import twilio from 'twilio';

export default async (req, res) => {
  const { businessInfo, qaPairs } = req.body;
  
  // 1. Save to database (mock function)
  await saveToDatabase(businessInfo.whatsappNumber, { businessInfo, qaPairs });

  // 2. Configure Twilio webhook
  const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messaging.v1.services(process.env.TWILIO_SERVICE_SID)
    .update({
      inboundRequestUrl: 'https://your-vercel-url.vercel.app/api/handle-message',
    });

  res.json({ success: true, whatsappNumber: process.env.TWILIO_PHONE_NUMBER });
};