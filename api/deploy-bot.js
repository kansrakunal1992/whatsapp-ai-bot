import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Validate input
  const { businessInfo, qaPairs } = req.body;
  
  if (!businessInfo?.whatsappNumber) {
    return res.status(400).json({ 
      error: "WhatsApp number is required",
      code: "MISSING_WHATSAPP_NUMBER" 
    });
  }

  // Ensure business_type has a value
  const validatedBusinessInfo = {
    ...businessInfo,
    businessType: businessInfo.businessType || 'Other'
  };

  // Format and validate number
  const cleanNumber = validatedBusinessInfo.whatsappNumber.replace(/\D/g, '');
  const formattedNumber = cleanNumber.startsWith('+') ? cleanNumber : `+${cleanNumber}`;

  if (!/^\+[1-9]\d{1,14}$/.test(formattedNumber)) {
    return res.status(400).json({ 
      error: "Invalid WhatsApp number format. Use E.164 format (+14155552671)",
      code: "INVALID_PHONE_FORMAT"
    });
  }

  const client = new Client(process.env.DATABASE_URL);
  
  try {
    await client.connect();
    await client.query('BEGIN');

    // Save business config (modified for your schema)
    const saveResult = await client.query(
      `INSERT INTO business_configs (
        whatsapp_number, business_name, 
        operating_hours, location, 
        business_type, language, qa_pairs,
        is_pro_account, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (whatsapp_number) 
       DO UPDATE SET
         business_name = EXCLUDED.business_name,
         operating_hours = EXCLUDED.operating_hours,
         location = EXCLUDED.location,
         business_type = EXCLUDED.business_type,
         language = EXCLUDED.language,
         qa_pairs = EXCLUDED.qa_pairs,
         updated_at = NOW()
       RETURNING whatsapp_number`,  // Using whatsapp_number instead of id
      [
        formattedNumber,
        validatedBusinessInfo.name,
        validatedBusinessInfo.operatingHours || null,
        validatedBusinessInfo.location || null,
        validatedBusinessInfo.businessType,
        validatedBusinessInfo.language,
        qaPairs,
        validatedBusinessInfo.isProAccount || false
      ]
    );

    // Configure Twilio webhook
    const webhookUrl = `${process.env.BASE_URL}/api/handle-message`;
    const numbers = await twilioClient.incomingPhoneNumbers.list({ 
      phoneNumber: formattedNumber,
      limit: 1
    });

    if (numbers.length === 0) {
      throw new Error(`Phone number ${formattedNumber} not found in Twilio account`);
    }

    await numbers[0].update({
      smsUrl: webhookUrl,
      smsMethod: 'POST',
      smsFilters: ['inbound']
    });

    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      whatsappNumber: formattedNumber,
      message: "Bot deployed successfully",
      webhook: webhookUrl
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Deployment error:", {
      error: error.message,
      code: error.code,
      stack: error.stack
    });

    // Handle Twilio-specific errors
    if (error.code === 20404) {
      return res.status(400).json({
        error: "Twilio account not found - check your credentials",
        code: "TWILIO_AUTH_ERROR"
      });
    }

    return res.status(500).json({ 
      error: "Bot deployment failed",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      code: "DEPLOYMENT_ERROR"
    });
  } finally {
    await client.end();
  }
};