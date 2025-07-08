import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export default async (req, res) => {
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

    const { rows: [businessConfig] } = await client.query(
      `SELECT 
        id,
        whatsapp_number,
        business_name, 
        operating_hours, 
        location, 
        language,
        qa_pairs
       FROM business_configs 
       WHERE whatsapp_number = $1
       LIMIT 1`,
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

    await client.query(
      `INSERT INTO message_logs (
        business_number, 
        customer_number, 
        message, 
        id,
        timestamp
       ) VALUES ($1, $2, $3, $4, NOW())
       RETURNING id`,
      [normalizedBusinessNumber, normalizedCustomerNumber, message, id]
    );

    const languageGreetings = {
      'Hindi': 'नमस्ते! आपकी कैसे मदद कर सकते हैं?',
      'Punjabi': 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕੀਤੀ ਜਾ ਸਕਦੀ ਹੈ?',
      'English': 'Hello! How can we help you today?',
      'Bengali': 'হ্যালো! আমরা আপনাকে কিভাবে সাহায্য করতে পারি?',
      'Tamil': 'வணக்கம்! நாங்கள் உங்களுக்கு எப்படி உதவ முடியும்?',
      'Telugu': 'హలో! మేము మీకు ఎలా సహాయం చేయగలము?',
      'Marathi': 'नमस्कार! आम्ही तुम्हाला कशी मदत करू शकतो?',
      'Gujarati': 'નમસ્તે! અમે તમને કેવી રીતે મદદ કરી શકીએ?',
      'Kannada': 'ನಮಸ್ಕಾರ! ನಾವು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?',
      'Malayalam': 'ഹലോ! ഞങ്ങൾക്ക് നിങ്ങളെ എങ്ങനെ സഹായിക്കാനാകും?',
      'Odia': 'ନମସ୍କାର! ଆମେ ଆପଣଙ୍କୁ କିପରି ସାହାଯ୍ୟ କରିପାରିବା?'
    };

    if (message.toLowerCase().startsWith('join')) {
      const greeting = languageGreetings[businessConfig.language] || languageGreetings['English'];
      const welcomeMessage = `${businessConfig.business_name}: ${greeting}`;
      await sendWhatsAppReply(businessNumber, customerNumber, welcomeMessage);
      await markMessageAsAnswered(client, id);
      responseSent = true;
      return res.status(200).send('OK');
    }

    if (businessConfig.qa_pairs && businessConfig.qa_pairs[message]) {
      await sendWhatsAppReply(businessNumber, customerNumber, businessConfig.qa_pairs[message]);
      await markMessageAsAnswered(client, id);
      responseSent = true;
      return res.status(200).send('OK');
    }

    const businessContext = {
      name: businessConfig.business_name,
      workingHours: formatWorkingHours(businessConfig.operating_hours),
      location: businessConfig.location || 'our location',
      knownAnswers: businessConfig.qa_pairs || {},
      phoneNumber: businessNumber
    };

    const aiResponse = await getAIResponse(
      message,
      businessContext,
      businessConfig.language
    );

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

async function markMessageAsAnswered(client, id) {
  if (!id) return;
  
  await client.query(
    `UPDATE message_logs
     SET is_answered = true,
         answered_at = NOW()
     WHERE id = $1`,
    [id]
  ).catch(err => console.error('Error marking message as answered:', err));
}