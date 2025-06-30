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

  const { businessInfo, qaPairs } = req.body;
  if (!businessInfo?.whatsappNumber) {
    return res.status(400).json({ error: "WhatsApp number is required" });
  }

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
        businessInfo.whatsappNumber,
        businessInfo.name,
        businessInfo.operatingHours,
        businessInfo.location,
        businessInfo.businessType,
        businessInfo.language,
        qaPairs
      ]
    );

    // Configure Twilio webhook
    const webhookUrl = `${process.env.BASE_URL}/api/handle-message`;
    await twilioClient.incomingPhoneNumbers
      .list({ phoneNumber: businessInfo.whatsappNumber })
      .then(numbers => {
        if (numbers.length > 0) {
          return numbers[0].update({
            smsUrl: webhookUrl,
            smsMethod: 'POST'
          });
        }
        throw new Error("Phone number not found in Twilio account");
      });

    return res.status(200).json({
      success: true,
      whatsappNumber: businessInfo.whatsappNumber,
      message: "Bot deployed successfully"
    });
  } catch (error) {
    console.error("Deployment error:", error);
    return res.status(500).json({ 
      error: error.message || "Bot deployment failed" 
    });
  } finally {
    await client.end();
  }
};
