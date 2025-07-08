import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export default async (req, res) => {
  // Validate Twilio signature in production
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

  // Parse incoming message
  const {
    From: customerNumber,
    To: businessNumber,
    Body: message,
    MessageSid: id
  } = req.body;

  console.log('Incoming message:', {
    from: customerNumber,
    to: businessNumber,
    body: message.substring(0, 50)
  });

  const normalizedBusinessNumber = businessNumber.replace('whatsapp:', '').replace('+', '');
  const normalizedCustomerNumber = customerNumber.replace('whatsapp:', '').replace('+', '');

  const client = new Client(process.env.DATABASE_URL);
  let responseSent = false;
  
  try {
    await client.connect();

    // Modified query to handle test/production mode
    const query = process.env.TEST_MODE === 'true'
      ? `SELECT * FROM business_configs WHERE whatsapp_number = $1 LIMIT 1`
      : `SELECT * FROM business_configs WHERE $1 = ANY(linked_numbers) LIMIT 1`;
    
    const { rows: [businessConfig] } = await client.query(
      query,
      [normalizedBusinessNumber]
    );

    if (!businessConfig) {
      console.error('Business config not found for:', normalizedBusinessNumber);
      await sendWhatsAppReply(
        businessNumber, 
        customerNumber, 
        'This business is not properly configured. Please contact support.'
      );
      responseSent = true;
      return res.status(200).send('OK');
    }

    console.log('Processing message with language:', businessConfig.language);

    // Log the message
    await client.query(
      `INSERT INTO message_logs (
        business_number, 
        customer_number, 
        message, 
        id,
        timestamp
       ) VALUES ($1, $2, $3, $4, NOW())`,
      [normalizedBusinessNumber, normalizedCustomerNumber, message, id]
    );

    // Language-specific greetings
    const languageGreetings = {
      'hindi': `नमस्ते! ${businessConfig.business_name} में आपका स्वागत है। आप कैसे मदद कर सकते हैं?`,
      'punjabi': `ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ${businessConfig.business_name} ਵਿੱਚ ਤੁਹਾਡਾ ਸੁਆਗਤ ਹੈ। ਅਸੀਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦੇ ਹਾਂ?`,
      'english': `Hello! Welcome to ${businessConfig.business_name}. How can we help you today?`,
      'bengali': `হ্যালো! ${businessConfig.business_name}-এ আপনাকে স্বাগতম। আমরা আপনাকে কিভাবে সাহায্য করতে পারি?`,
      'tamil': `வணக்கம்! ${businessConfig.business_name}-இல் உங்களை வரவேற்கிறோம். நாங்கள் உங்களுக்கு எப்படி உதவ முடியும்?`,
      'telugu': `హలో! ${businessConfig.business_name}కు స్వాగతం. మేము మీకు ఎలా సహాయం చేయగలము?`,
      'marathi': `नमस्कार! ${businessConfig.business_name} मध्ये आपले स्वागत आहे. आम्ही तुम्हाला कशी मदत करू शकतो?`,
      'gujarati': `નમસ્તે! ${businessConfig.business_name} માં આપનું સ્વાગત છે. અમે તમને કેવી રીતે મદદ કરી શકીએ?`,
      'kannada': `ನಮಸ್ಕಾರ! ${businessConfig.business_name}ಕ್ಕೆ ಸುಸ್ವಾಗತ. ನಾವು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?`,
      'malayalam': `ഹലോ! ${businessConfig.business_name}-ലേക്ക് സ്വാഗതം. ഞങ്ങൾക്ക് നിങ്ങളെ എങ്ങനെ സഹായിക്കാനാകും?`,
      'odia': `ନମସ୍କାର! ${businessConfig.business_name} ରେ ଆପଣଙ୍କୁ ସ୍ୱାଗତ। ଆମେ ଆପଣଙ୍କୁ କିପରି ସାହାଯ୍ୟ କରିପାରିବା?`
    };

    // Handle 'join' command
    if (message.toLowerCase().startsWith('join')) {
      const langKey = (businessConfig.language || 'english').toLowerCase();
      const welcomeMessage = languageGreetings[langKey] || languageGreetings['english'];
      await sendWhatsAppReply(businessNumber, customerNumber, welcomeMessage);
      await markMessageAsAnswered(client, id);
      responseSent = true;
      return res.status(200).send('OK');
    }

    // Check for exact Q&A match
    if (businessConfig.qa_pairs && businessConfig.qa_pairs[message]) {
      await sendWhatsAppReply(businessNumber, customerNumber, businessConfig.qa_pairs[message]);
      await markMessageAsAnswered(client, id);
      responseSent = true;
      return res.status(200).send('OK');
    }

    // Prepare context for AI response
    const businessContext = {
      name: businessConfig.business_name,
      workingHours: formatWorkingHours(businessConfig.operating_hours),
      location: businessConfig.location || 'our location',
      knownAnswers: businessConfig.qa_pairs || {},
      phoneNumber: businessNumber
    };

    // Generate AI response
    const aiResponse = await getAIResponse(
      message,
      businessContext,
      businessConfig.language
    );

    // Send response
    await sendWhatsAppReply(businessNumber, customerNumber, aiResponse);
    await markMessageAsAnswered(client, id);
    responseSent = true;

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error handling message:', error);
    
    if (!responseSent) {
      try {
        await sendWhatsAppReply(
          businessNumber, 
          customerNumber, 
          'We are currently experiencing high volume. Please try again later.'
        );
      } catch (twilioError) {
        console.error('Twilio fallback failed:', twilioError);
      }
    }
    
    return res.status(500).send('Error processing message');
  } finally {
    await client.end().catch(e => console.error('Error closing connection:', e));
  }
};

// Helper function to format working hours
function formatWorkingHours(hours) {
  if (!hours) return 'our business hours';
  if (typeof hours === 'string') return hours;
  
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

// Helper function to send WhatsApp reply
async function sendWhatsAppReply(from, to, message) {
  try {
    console.log('Sending WhatsApp message:', {
      from,
      to,
      message: message.substring(0, 50) + '...'
    });

    return await twilioClient.messages.create({
      body: message,
      from: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`
    });
  } catch (error) {
    console.error('Error in sendWhatsAppReply:', error);
    throw error;
  }
}

// Helper function to mark message as answered
async function markMessageAsAnswered(client, id) {
  if (!id) return;
  
  await client.query(
    `UPDATE message_logs
     SET is_answered = true
     WHERE id = $1`,
    [id]
  ).catch(err => console.error('Error marking message as answered:', err));
}