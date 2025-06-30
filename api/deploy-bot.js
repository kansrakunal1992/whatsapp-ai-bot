import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Validate environment variables
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return res.status(500).json({ error: "Twilio credentials not configured" });
  }

  const { businessInfo, qaPairs } = req.body;

  // Input validation
  if (!businessInfo?.whatsappNumber) {
    return res.status(400).json({ error: "WhatsApp number is required" });
  }

  if (!businessInfo.name || !businessInfo.language) {
    return res.status(400).json({ error: "Business name and language are required" });
  }

  if (!qaPairs || typeof qaPairs !== 'object' || Object.keys(qaPairs).length === 0) {
    return res.status(400).json({ error: "At least one Q&A pair is required" });
  }

  // Format and validate number
  const cleanNumber = businessInfo.whatsappNumber.replace(/\D/g, '');
  const formattedNumber = cleanNumber.startsWith('+') ? cleanNumber : `+${cleanNumber}`;

  const client = new Client(process.env.DATABASE_URL);
  
  try {
    await client.connect();
    
    // Save business config to Neon DB
    await client.query(
      `INSERT INTO business_configs (
        whatsapp_number, business_name, 
        operating_hours, location, 
        business_type, language, qa_pairs
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (whatsapp_number) 
       DO UPDATE SET
         business_name = EXCLUDED.business_name,
         operating_hours = EXCLUDED.operating_hours,
         location = EXCLUDED.location,
         business_type = EXCLUDED.business_type,
         language = EXCLUDED.language,
         qa_pairs = EXCLUDED.qa_pairs`,
      [
        formattedNumber,
        businessInfo.name,
        businessInfo.operatingHours || null,
        businessInfo.location || null,
        businessInfo.businessType || 'Other',
        businessInfo.language,
        qaPairs
      ]
    );

    // Configure Twilio webhook
    const webhookUrl = `${process.env.BASE_URL}/api/handle-message`;
    const numbers = await twilioClient.incomingPhoneNumbers.list({ phoneNumber: formattedNumber });

    if (numbers.length === 0) {
      throw new Error("Phone number not found in Twilio account");
    }

    await numbers[0].update({
      smsUrl: webhookUrl,
      smsMethod: 'POST',
      smsFilters: ['inbound']
    });

    return res.status(200).json({
      success: true,
      whatsappNumber: formattedNumber,
      message: "Bot deployed successfully",
      webhook: webhookUrl
    });

  } catch (error) {
    console.error("Deployment error:", {
      error: error.message,
      number: formattedNumber,
      endpoint: '/api/deploy-bot',
      timestamp: new Date().toISOString()
    });
    
    return res.status(500).json({ 
      error: "Bot deployment failed",
      ...(process.env.NODE_ENV === 'development' && { details: error.message })
    });
  } finally {
    await client.end();
  }
};
