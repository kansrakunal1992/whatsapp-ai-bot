import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Helper: Format Indian numbers to E.164
function formatIndianNumber(rawNumber) {
  const clean = rawNumber.replace(/\D/g, '');
  if (/^\+91\d{10}$/.test(rawNumber)) return rawNumber;
  if (/^91\d{10}$/.test(clean)) return `+${clean}`;
  if (/^\d{10}$/.test(clean)) return `+91${clean}`;
  throw new Error('Invalid Indian number format');
}

export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. INPUT VALIDATION
  const { businessInfo, qaPairs } = req.body;
  
  if (!businessInfo?.whatsappNumber) {
    return res.status(400).json({ 
      error: "Business WhatsApp number is required",
      code: "MISSING_NUMBER",
      solution: "Provide a 10-digit Indian number or +91XXXXXXXXXX format"
    });
  }

  // 2. PHONE NUMBER PROCESSING
  let formattedNumber;
  try {
    formattedNumber = formatIndianNumber(businessInfo.whatsappNumber);
  } catch (error) {
    return res.status(400).json({ 
      error: error.message,
      code: "INVALID_NUMBER_FORMAT",
      solution: "Use 10-digit Indian number or +91XXXXXXXXXX format"
    });
  }

  // 3. DATABASE OPERATIONS
  const client = new Client(process.env.DATABASE_URL);
  
  try {
    await client.connect();
    await client.query('BEGIN');

    // Save/update business config
    await client.query(
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
         updated_at = NOW()`,
      [
        formattedNumber,
        businessInfo.name || "My Business",
        businessInfo.operatingHours || { opening: "09:00", closing: "18:00" },
        businessInfo.location || "Not specified",
        businessInfo.businessType || "Other",
        businessInfo.language || "English",
        qaPairs || {},
        false // is_pro_account
      ]
    );

    // 4. TWILIO SANDBOX CONFIGURATION
    const webhookUrl = `${process.env.BASE_URL}/api/handle-message`;
    let sandboxPhone;

    try {
      // Method 1: Get existing WhatsApp-enabled number
      const numbers = await twilioClient.incomingPhoneNumbers.list({ limit: 20 });
      sandboxPhone = numbers.find(n => 
        n.capabilities.whatsapp === true
      )?.phoneNumber;

      // Method 2: Fallback to default sandbox number
      if (!sandboxPhone) {
        sandboxPhone = '+14155238886'; // Twilio's default sandbox
        console.warn("Using default sandbox number - configure a dedicated number in Twilio");
      }

      // Verify webhook URL
      if (!webhookUrl.startsWith('https://')) {
        throw new Error("BASE_URL must start with https:// for Twilio webhooks");
      }

      // Link sandbox number to business
      await client.query(
        `UPDATE business_configs 
         SET linked_numbers = array_append(COALESCE(linked_numbers, ARRAY[]::text[]), $1)
         WHERE whatsapp_number = $2`,
        [sandboxPhone, formattedNumber]
      );

    } catch (twilioError) {
      console.error("Twilio number detection failed:", twilioError);
      throw new Error(`WhatsApp setup failed: ${twilioError.message}`);
    }

    await client.query('COMMIT');

    // 5. SUCCESS RESPONSE
    return res.status(200).json({
      success: true,
      businessNumber: formattedNumber,
      sandboxNumber: sandboxPhone,
      setupInstructions: [
        `1. Share this Sandbox Number: ${sandboxPhone}`,
        `2. Customers MUST send first: "join <unique-word>"`,
        `3. Test now: https://wa.me/${sandboxPhone.replace('+', '')}?text=join`,
        `4. Full guide: https://twil.io/whatsapp-sandbox`
      ],
      webhookConfigured: webhookUrl,
      nextSteps: [
        "Test with 2-3 messages to verify setup",
        "Contact support to upgrade to dedicated number"
      ]
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Deployment error:", {
      error: error.message,
      stack: error.stack,
      payload: req.body ? JSON.stringify(req.body).slice(0, 200) : null
    });

    return res.status(500).json({
      error: error.message.includes("Twilio") 
        ? "WhatsApp configuration failed" 
        : "Database operation failed",
      code: error.message.includes("Twilio") ? "TWILIO_ERROR" : "DB_ERROR",
      solutionSteps: [
        "1. Verify Twilio credentials in .env",
        "2. Check Twilio console has WhatsApp enabled",
        "3. Ensure BASE_URL is HTTPS",
        "4. Retry with simpler payload"
      ],
      supportContact: "whatsapp-support@yourdomain.com"
    });
  } finally {
    await client.end();
  }
};