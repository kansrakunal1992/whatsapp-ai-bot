import twilio from 'twilio';

export default async (req, res) => {
  // Add error handling
  if (!req.body?.businessInfo?.whatsappNumber || !req.body.qaPairs) {
    return res.status(400).json({ 
      success: false, 
      message: "Missing businessInfo or qaPairs in request" 
    });
  }

  const { businessInfo, qaPairs } = req.body;
  
  try {
    // 1. Save to database (mock function)
    await saveToDatabase(businessInfo.whatsappNumber, { businessInfo, qaPairs });

    // 2. Configure Twilio webhook
    const client = twilio(
      process.env.TWILIO_SID, 
      process.env.TWILIO_AUTH_TOKEN
    );
    
    // UPDATE THIS LINE with your actual Vercel URL:
    await client.messaging.v1.services(process.env.TWILIO_SERVICE_SID)
      .update({
        inboundRequestUrl: 'https://whatsapp-ai-bot-1ox3-git-main-kunal-kansras-projects.vercel.app/api/handle-message',
      });

    res.json({ 
      success: true, 
      whatsappNumber: process.env.TWILIO_PHONE_NUMBER,
      message: "Bot deployed successfully!" // Added for frontend display
    });
    
  } catch (error) {
    console.error("Deployment error:", error);
    res.status(500).json({ 
      success: false, 
      message: error.message || "Deployment failed" 
    });
  }
};