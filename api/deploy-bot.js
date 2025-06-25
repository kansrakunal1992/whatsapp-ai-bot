import twilio from 'twilio';

// Mock database function (remove if you have a real implementation)
const saveToDatabase = async (id, data) => {
  console.log("Mock save:", id, data);
  return true;
};

export default async (req, res) => {
  console.log("Request received:", req.method, req.body);
  
  try {
    // Validate request
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { businessInfo, qaPairs } = req.body;
    
    // Validate required fields
    if (!businessInfo?.whatsappNumber || !qaPairs) {
      return res.status(400).json({ 
        error: 'Missing businessInfo.whatsappNumber or qaPairs' 
      });
    }

    // 1. Mock database save
    await saveToDatabase(businessInfo.whatsappNumber, { businessInfo, qaPairs });

    // 2. Initialize Twilio (verify env vars exist)
    if (!process.env.TWILIO_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('Twilio credentials missing');
    }
    
    const client = twilio(
      process.env.TWILIO_SID, 
      process.env.TWILIO_AUTH_TOKEN
    );

    // 3. Update webhook (ensure SERVICE_SID exists)
    await client.messaging.v1.services(process.env.TWILIO_SERVICE_SID)
      .update({
        inboundRequestUrl: 'https://whatsapp-ai-bot-1ox3-git-main-kunal-kansras-projects.vercel.app/api/handle-message',
      });

    // Success response
    res.json({ 
      success: true, 
      whatsappNumber: process.env.TWILIO_PHONE_NUMBER 
    });

  } catch (error) {
    console.error("CRASH:", error);
    res.status(500).json({ 
      error: error.message || 'Internal server error',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};