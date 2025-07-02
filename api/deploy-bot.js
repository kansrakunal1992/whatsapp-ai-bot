import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';

// Initialize Twilio client with environment variables
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Enhanced error handling middleware
const handleErrors = (error, req, res) => {
  console.error("Deployment error:", {
    error: error.message,
    endpoint: req.url,
    method: req.method,
    timestamp: new Date().toISOString(),
    payload: req.body ? JSON.stringify(req.body).slice(0, 200) : 'none'
  });

  return res.status(500).json({ 
    error: "Bot deployment failed",
    ...(process.env.NODE_ENV === 'development' && { details: error.message })
  });
};

export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Validate environment variables
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return handleErrors(new Error("Twilio credentials not configured"), req, res);
  }

  const { businessInfo, qaPairs } = req.body;

  // Enhanced input validation
  if (!businessInfo?.whatsappNumber) {
    return res.status(400).json({ error: "WhatsApp number is required" });
  }

  if (!businessInfo.name || !businessInfo.language) {
    return res.status(400).json({ 
      error: "Business name and language are required"
    });
  }

  if (!qaPairs || typeof qaPairs !== 'object' || Object.keys(qaPairs).length === 0) {
    return res.status(400).json({ 
      error: "At least one Q&A pair is required"
    });
  }

  // Format and validate number
  const cleanNumber = businessInfo.whatsappNumber.replace(/\D/g, '');
  const formattedNumber = cleanNumber.startsWith('+') ? cleanNumber : `+${cleanNumber}`;

  // Validate phone number format
  if (!/^\+[1-9]\d{1,14}$/.test(formattedNumber)) {
    return res.status(400).json({ 
      error: "Invalid WhatsApp number format" 
    });
  }

  const client = new Client(process.env.DATABASE_URL);
  
  try {
    await client.connect();
    
    // Begin transaction for atomic operations
    await client.query('BEGIN');

    // Save business config to Neon DB
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
       RETURNING id`,
      [
        formattedNumber,
        businessInfo.name,
        businessInfo.operatingHours || null,
        businessInfo.location || null,
        businessInfo.businessType || 'Other',
        businessInfo.language,
        qaPairs,
        businessInfo.isProAccount || false
      ]
    );

    if (!saveResult.rows[0]?.id) {
      throw new Error("Failed to save business configuration");
    }

    // Configure Twilio webhook
    const webhookUrl = `${process.env.BASE_URL}/api/handle-message`;
    const numbers = await twilioClient.incomingPhoneNumbers.list({ 
      phoneNumber: formattedNumber,
      limit: 1
    });

    if (numbers.length === 0) {
      throw new Error(`Phone number ${formattedNumber} not found in Twilio account`);
    }

    const twilioUpdate = await numbers[0].update({
      smsUrl: webhookUrl,
      smsMethod: 'POST',
      smsFilters: ['inbound']
    });

    // Validate Twilio configuration
    if (twilioUpdate.smsUrl !== webhookUrl) {
      throw new Error("Twilio webhook configuration failed");
    }

    // Commit transaction if all operations succeeded
    await client.query('COMMIT');

    // Log successful deployment
    console.log("Bot deployed successfully:", {
      whatsappNumber: formattedNumber,
      businessName: businessInfo.name,
      timestamp: new Date().toISOString()
    });

    return res.status(200).json({
      success: true,
      whatsappNumber: formattedNumber,
      message: "Bot deployed successfully",
      webhook: webhookUrl,
      businessId: saveResult.rows[0].id
    });

  } catch (error) {
    // Rollback transaction on error
    await client.query('ROLLBACK').catch(rollbackError => {
      console.error("Transaction rollback failed:", rollbackError);
    });

    return handleErrors(error, req, res);
  } finally {
    await client.end().catch(endError => {
      console.error("Failed to close database connection:", endError);
    });
  }
};