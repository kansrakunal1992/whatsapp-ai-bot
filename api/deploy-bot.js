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

  // =================================================================
  // 1. INPUT VALIDATION
  // =================================================================
  const { businessInfo, qaPairs } = req.body;
  
  if (!businessInfo?.whatsappNumber) {
    return res.status(400).json({ 
      error: "Business WhatsApp number is required",
      code: "MISSING_NUMBER" 
    });
  }

  // =================================================================
  // 2. PHONE NUMBER PROCESSING
  // =================================================================
  let formattedNumber;
  try {
    formattedNumber = formatIndianNumber(businessInfo.whatsappNumber);
  } catch (error) {
    return res.status(400).json({ 
      error: error.message,
      solution: "Use 10-digit Indian number or +91XXXXXXXXXX format"
    });
  }

  // =================================================================
  // 3. DATABASE OPERATIONS
  // =================================================================
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

    // =================================================================
    // 4. TWILIO SANDBOX CONFIGURATION
    // =================================================================
    const webhookUrl = `${process.env.BASE_URL}/api/handle-message`;
    
    // A. Find existing sandbox or create new
    let sandboxNumber;
    try {
      const sandboxes = await twilioClient.messaging.v1.services.list();
      const existingSandbox = sandboxes.find(s => s.friendlyName.includes("Sandbox"));
      
      sandboxNumber = existingSandbox 
        ? existingSandbox 
        : await twilioClient.messaging.v1.services.create({
            friendlyName: `${businessInfo.name} WhatsApp Bot`,
            inboundRequestUrl: webhookUrl,
            statusCallback: `${process.env.BASE_URL}/api/handle-status`
          });
    } catch (twilioError) {
      console.error("Twilio sandbox setup failed:", twilioError);
      throw new Error("Failed to configure WhatsApp Sandbox");
    }

    // B. Get the sandbox phone number
    const sandboxPhone = (await twilioClient.incomingPhoneNumbers.list())
      .find(n => n.friendlyName.includes("Sandbox"));

    await client.query('COMMIT');

    // =================================================================
    // 5. SUCCESS RESPONSE
    // =================================================================
    return res.status(200).json({
      success: true,
      businessNumber: formattedNumber, // Owner's number (for records)
      sandboxNumber: sandboxPhone.phoneNumber,
      setupInstructions: [
        `1. Share this Sandbox Number with customers: ${sandboxPhone.phoneNumber}`,
        `2. Customers MUST FIRST send: "join <unique-word>"`,
        `3. Test now: https://wa.me/${sandboxPhone.phoneNumber.replace('+', '')}?text=join`
      ],
      upgradeNote: "Contact support to upgrade to a dedicated WhatsApp Business number"
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Deployment error:", error.message);

    return res.status(500).json({ 
      error: error.message.includes("Twilio") 
        ? "WhatsApp Sandbox configuration failed" 
        : "Database operation failed",
      solution: error.message.includes("Sandbox")
        ? "Ensure your Twilio account has WhatsApp Sandbox access"
        : "Check database connection settings"
    });
  } finally {
    await client.end();
  }
};