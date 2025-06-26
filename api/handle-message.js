import { Client } from '@neondatabase/serverless';
import { MessagingResponse } from 'twilio/lib/twiml/MessagingResponse';

export default async (req, res) => {
    // Set response headers
    res.setHeader('Content-Type', 'text/xml');
    const twiml = new MessagingResponse();
    let neonClient;

    try {
        // 1. Validate Twilio request (if auth token exists)
        if (process.env.TWILIO_AUTH_TOKEN) {
            const twilioSignature = req.headers['x-twilio-signature'];
            const url = `${process.env.BASE_URL}/api/handle-message`;
            const params = req.body;

            const validator = require('twilio').validateRequest;
            const isValid = validator(
                process.env.TWILIO_AUTH_TOKEN,
                twilioSignature,
                url,
                params
            );

            if (!isValid) {
                console.error('Invalid Twilio signature');
                throw new Error('Invalid request signature');
            }
        }

        // 2. Get message data
        const userNumber = req.body.From;
        const userMessage = req.body.Body.trim().toLowerCase();
        console.log(`Message from ${userNumber}: "${userMessage}"`);

        // 3. Connect to Neon DB
        neonClient = new Client(process.env.DATABASE_URL);
        await neonClient.connect();

        // 4. Track message count and check limit
        const countResult = await neonClient.query(`
            INSERT INTO message_counts (user_number, count)
            VALUES ($1, 1)
            ON CONFLICT (user_number) 
            DO UPDATE SET count = message_counts.count + 1
            RETURNING count
        `, [userNumber]);

        const currentCount = countResult.rows[0].count;

        if (currentCount > 30) {
            twiml.message("🚫 Free trial limit reached (30/30 messages). Please upgrade for unlimited access.");
            return res.send(twiml.toString());
        }

        // 5. Get business configuration
        const businessConfig = await neonClient.query(`
            SELECT 
                qa_pairs,
                operating_hours->>'opening' as opening_time,
                operating_hours->>'closing' as closing_time,
                language
            FROM business_configs
            WHERE whatsapp_number = $1
        `, [userNumber]);

        // 6. Check business hours
        if (businessConfig.rows.length > 0) {
            const config = businessConfig.rows[0];
            const now = new Date();
            const currentHours = now.getHours();
            const currentMinutes = now.getMinutes();
            
            if (config.opening_time && config.closing_time) {
                const [openingHour, openingMinute] = config.opening_time.split(':').map(Number);
                const [closingHour, closingMinute] = config.closing_time.split(':').map(Number);
                
                const isBeforeOpening = currentHours < openingHour || 
                                      (currentHours === openingHour && currentMinutes < openingMinute);
                const isAfterClosing = currentHours > closingHour || 
                                     (currentHours === closingHour && currentMinutes > closingMinute);
                
                if (isBeforeOpening || isAfterClosing) {
                    twiml.message(`⏳ We're currently closed. Our hours: ${config.opening_time} to ${config.closing_time}`);
                    return res.send(twiml.toString());
                }
            }

            // 7. Check for custom Q&A response
            if (config.qa_pairs && config.qa_pairs[userMessage]) {
                twiml.message(config.qa_pairs[userMessage]);
                return res.send(twiml.toString());
            }
        }

        // 8. Default responses
        const defaultResponses = {
            'hi': 'Hello! Thanks for messaging us.',
            'hello': 'Hello! How can I help you today?',
            'help': 'Please describe your question and we\'ll assist you.',
            'default': `We received your message: "${userMessage}". Our team will respond shortly.`
        };

        const reply = defaultResponses[userMessage] || defaultResponses.default;
        twiml.message(reply);

    } catch (error) {
        console.error('Error processing message:', error);
        twiml.message("⚠️ We're experiencing technical difficulties. Please try again later.");
    } finally {
        // Close DB connection
        if (neonClient) {
            try {
                await neonClient.end();
            } catch (e) {
                console.error('Error closing DB connection:', e);
            }
        }
    }

    // Send final response
    return res.send(twiml.toString());
};