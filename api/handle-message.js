// handle-message.js
import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export default async (req, res) => {
  // 1. Validate Twilio signature (for production)
  if (process.env.NODE_ENV === 'production') {
    const signature = req.headers['x-twilio-signature'];
    const url = process.env.BASE_URL + req.url;
    const params = req.body;
    
    if (!twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      signature,
      url,
      params
    )) {
      return res.status(403).send('Invalid Twilio signature');
    }
  }

  // 2. Extract and log incoming message details
  const {
    From: customerNumber,
    To: businessNumber,
    Body: message
  } = req.body;

  console.log('Incoming message:', {
    from: customerNumber,
    to: businessNumber,
    body: message
  });

  // Normalize numbers for DB lookup
  const normalizedBusinessNumber = businessNumber.replace('whatsapp:', '').replace('+', '');
  const normalizedCustomerNumber = customerNumber.replace('whatsapp:', '').replace('+', '');

  const client = new Client(process.env.DATABASE_URL);
  
  try {
    await client.connect();

    // 3. Fetch business config with flexible number matching
    const { rows: [businessConfig] } = await client.query(`
      SELECT 
        business_name, 
        operating_hours, 
        location, 
        business_type, 
        language,
        qa_pairs,
        is_pro_account,
        price_range,
        services,
        discount_groups
      FROM business_configs 
      WHERE $1 LIKE '%' || whatsapp_number || '%'
      LIMIT 1
    `, [normalizedBusinessNumber]);

    if (!businessConfig) {
      console.error('Business config not found for:', normalizedBusinessNumber);
      await sendWhatsAppReply(
        businessNumber, 
        customerNumber, 
        'This business is not properly configured. Please contact support.'
      );
      return res.status(200).send('OK');
    }

    // 4. Log the incoming message
    await client.query(`
      INSERT INTO message_logs (
        business_number, 
        customer_number, 
        message, 
        timestamp,
        is_answered
      ) VALUES ($1, $2, $3, NOW(), false)
    `, [normalizedBusinessNumber, normalizedCustomerNumber, message]);

    // 5. Check if message is "join" command (Twilio sandbox requirement)
    if (message.toLowerCase().startsWith('join')) {
      const welcomeMessage = businessConfig.language === 'Hindi' 
        ? `नमस्ते! ${businessConfig.business_name} में आपका स्वागत है। आप कैसे मदद कर सकते हैं?`
        : `Hello! Welcome to ${businessConfig.business_name}. How can we help you today?`;
      
      await sendWhatsAppReply(businessNumber, customerNumber, welcomeMessage);
      await markMessageAsAnswered(client, normalizedBusinessNumber, normalizedCustomerNumber);
      return res.status(200).send('OK');
    }

    // 6. Check for exact match in Q&A pairs first
    if (businessConfig.qa_pairs && businessConfig.qa_pairs[message]) {
      await sendWhatsAppReply(businessNumber, customerNumber, businessConfig.qa_pairs[message]);
      await markMessageAsAnswered(client, normalizedBusinessNumber, normalizedCustomerNumber);
      return res.status(200).send('OK');
    }

    // 7. Prepare business context for AI
    const businessContext = {
      name: businessConfig.business_name,
      workingHours: formatWorkingHours(businessConfig.operating_hours),
      location: businessConfig.location,
      priceRange: businessConfig.price_range || 'various prices',
      services: businessConfig.services || 'our services',
      discountGroups: businessConfig.discount_groups || 'eligible customers',
      knownAnswers: businessConfig.qa_pairs || {},
      phoneNumber: businessNumber
    };

    // 8. Get AI response
    const aiResponse = await getAIResponse(
      message,
      businessContext,
      businessConfig.language
    );

    // 9. Send response via Twilio
    await sendWhatsAppReply(businessNumber, customerNumber, aiResponse);
    await markMessageAsAnswered(client, normalizedBusinessNumber, normalizedCustomerNumber);

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error handling message:', error);
    
    // Fallback response
    try {
      await sendWhatsAppReply(
        businessNumber, 
        customerNumber, 
        'We are currently experiencing high volume. Please try again later.'
      );
    } catch (twilioError) {
      console.error('Twilio fallback failed:', twilioError);
    }
    
    return res.status(500).send('Error processing message');
  } finally {
    await client.end();
  }
};

// Helper: Format working hours for response
function formatWorkingHours(hours) {
  if (!hours) return 'our business hours';
  if (typeof hours === 'string') return hours;
  
  // Format time strings if they're in HH:MM format
  const formatTime = (timeStr) => {
    if (!timeStr) return '';
    if (timeStr.includes('AM') || timeStr.includes('PM')) return timeStr;
    
    const [hours, minutes] = timeStr.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${minutes} ${ampm}`;
  };

  return `from ${formatTime(hours.opening)} to ${formatTime(hours.closing)}`;
}

// Helper: Send WhatsApp reply via Twilio (with robust number formatting)
async function sendWhatsAppReply(from, to, message) {
  try {
    // Clean and format numbers
    const cleanFrom = from.replace('whatsapp:', '').replace('+', '');
    const cleanTo = to.replace('whatsapp:', '').replace('+', '');
    
    // Format Indian numbers (10 digits after 91)
    const isIndianNumber = (num) => num.startsWith('91') && num.length === 12;
    
    const formattedTo = isIndianNumber(cleanTo) 
      ? `whatsapp:+${cleanTo}`
      : `whatsapp:${cleanTo}`;

    const formattedFrom = isIndianNumber(cleanFrom)
      ? `whatsapp:+${cleanFrom}`
      : `whatsapp:${cleanFrom}`;

    console.log('Sending WhatsApp message:', {
      from: formattedFrom,
      to: formattedTo,
      message: message.substring(0, 50) + '...'
    });

    return await twilioClient.messages.create({
      body: message,
      from: formattedFrom,
      to: formattedTo
    });
  } catch (error) {
    console.error('Error in sendWhatsAppReply:', {
      originalFrom: from,
      originalTo: to,
      error: error.message
    });
    throw error;
  }
}

// Helper: Mark message as answered in DB
async function markMessageAsAnswered(client, businessNumber, customerNumber) {
  await client.query(`
    UPDATE message_logs
    SET is_answered = true,
        answered_at = NOW(),
        response = $3
    WHERE business_number = $1
    AND customer_number = $2
    AND is_answered = false
    ORDER BY timestamp DESC
    LIMIT 1
  `, [businessNumber, customerNumber, 'Response sent']);
}