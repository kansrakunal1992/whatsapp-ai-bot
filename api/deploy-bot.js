import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Helper: Format Indian numbers to E.164 standard
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

    // 3.1 Check for number conflicts
    const conflictCheck = await client.query(
      `SELECT business_name FROM business_configs 
       WHERE $1 = ANY(linked_numbers) AND whatsapp_number != $2
       LIMIT 1`,
      [formattedNumber, formattedNumber]
    );

    if (conflictCheck.rows.length > 0) {
      throw new Error(`This number is already linked to ${conflictCheck.rows[0].business_name}`);
    }

    // 3.2 Upsert business configuration
    const upsertResult = await client.query(
      `INSERT INTO business_configs (
        whatsapp_number, business_name, 
        operating_hours, location, 
        business_type, language, qa_pairs,
        is_pro_account, created_at, linked_numbers
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
       ON CONFLICT (whatsapp_number) 
       DO UPDATE SET
         business_name = EXCLUDED.business_name,
         operating_hours = EXCLUDED.operating_hours,
         location = EXCLUDED.location,
         business_type = EXCLUDED.business_type,
         language = EXCLUDED.language,
         qa_pairs = EXCLUDED.qa_pairs,
         linked_numbers = (
           SELECT ARRAY(
             SELECT DISTINCT unnest(
               COALESCE(business_configs.linked_numbers, ARRAY[]::text[]) || 
               COALESCE(EXCLUDED.linked_numbers, ARRAY[]::text[])
             )
           )
         ),
         updated_at = NOW()
       RETURNING *`,
      [
        formattedNumber,
        businessInfo.name || "My Business",
        businessInfo.operatingHours || { opening: "09:00", closing: "18:00" },
        businessInfo.location || "Not specified",
        businessInfo.businessType || "Other",
        businessInfo.language || "English",
        qaPairs || {},
        false,
        [formattedNumber] // Initial linked_numbers value
      ]
    );

    const businessConfig = upsertResult.rows[0];

    // 4. TWILIO CONFIGURATION
    const webhookUrl = `${process.env.BASE_URL}/api/handle-message`;
    let whatsappPhone;

    try {
      if (process.env.TEST_MODE === 'true') {
        // Sandbox configuration - flexible number detection
        const numbers = await twilioClient.incomingPhoneNumbers.list({ limit: 20 });
        whatsappPhone = numbers.find(n => n.capabilities.whatsapp === true)?.phoneNumber;
        
        if (!whatsappPhone) {
          whatsappPhone = '+14155238886'; // Default sandbox fallback
          console.warn("Using default sandbox number");
        }

        // Add sandbox number to linked_numbers if not present
        if (!businessConfig.linked_numbers.includes(whatsappPhone)) {
          await client.query(
            `UPDATE business_configs 
             SET linked_numbers = array_append(linked_numbers, $1)
             WHERE whatsapp_number = $2`,
            [whatsappPhone, formattedNumber]
          );
        }
      } else {
        // Production configuration
        whatsappPhone = formattedNumber;
        const numbers = await twilioClient.incomingPhoneNumbers.list({ phoneNumber: whatsappPhone });
        if (numbers.length === 0) {
          throw new Error(`Number ${whatsappPhone} not found in Twilio account`);
        }
      }

      // Verify HTTPS for webhook
      if (!webhookUrl.startsWith('https://')) {
        throw new Error("BASE_URL must be HTTPS");
      }

      // Configure webhook for both sandbox and production
      await twilioClient.incomingPhoneNumbers(whatsappPhone)
        .update({ 
          smsUrl: webhookUrl,
          whatsappUrl: webhookUrl 
        });

    } catch (twilioError) {
      console.error("Twilio configuration failed:", {
        error: twilioError.message,
        number: whatsappPhone,
        testMode: process.env.TEST_MODE
      });
      throw new Error(
        process.env.TEST_MODE === 'true'
          ? "Sandbox setup failed. Send 'join <word>' to +14155238886 first."
          : `Production setup failed: ${twilioError.message}`
      );
    }

    await client.query('COMMIT');

    // 5. SUCCESS RESPONSE
    return res.status(200).json({
      success: true,
      businessNumber: formattedNumber,
      whatsappNumber: whatsappPhone,
      mode: process.env.TEST_MODE === 'true' ? 'sandbox' : 'production',
      setupInstructions: process.env.TEST_MODE === 'true' ? [
        `1. Share this Sandbox Number: ${whatsappPhone}`,
        `2. Customers MUST send first: "join <unique-word>"`,
        `3. Test now: https://wa.me/${whatsappPhone.replace('+', '')}?text=join`,
        `4. Full guide: https://twil.io/whatsapp-sandbox`
      ] : [
        `1. Your WhatsApp Business Number: ${whatsappPhone}`,
        `2. Customers can message you directly`,
        `3. Test now: https://wa.me/${whatsappPhone.replace('+', '')}`
      ],
      webhookConfigured: webhookUrl,
      nextSteps: [
        "Test with 2-3 messages to verify setup",
        process.env.TEST_MODE === 'true' 
          ? "Contact support to upgrade to production" 
          : "Monitor your dashboard for incoming messages"
      ],
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Deployment error:", {
      error: error.message,
      stack: error.stack,
      testMode: process.env.TEST_MODE,
      number: formattedNumber
    });

    return res.status(500).json({
      error: error.message,
      code: error.message.includes("Twilio") ? "TWILIO_ERROR" : "DB_ERROR",
      solutionSteps: [
        process.env.TEST_MODE === 'true'
          ? "1. Send 'join <word>' to +14155238886 first"
          : "1. Verify number is purchased in Twilio",
        "2. Check Twilio account credentials",
        "3. Ensure BASE_URL is HTTPS",
        "4. Contact support if issue persists"
      ],
      supportContact: "support@yourdomain.com",
      timestamp: new Date().toISOString()
    });
  } finally {
    await client.end().catch(e => console.error('Error closing connection:', e));
  }
};