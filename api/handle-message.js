import { Client } from '@neondatabase/serverless';
import twilio from 'twilio';

export default async (req, res) => {
    res.setHeader('Content-Type', 'text/xml');
    const twiml = new twilio.twiml.MessagingResponse();
    let neonClient;

    try {
        // 1. Validate Twilio request
        if (process.env.TWILIO_AUTH_TOKEN) {
            const isValid = twilio.validateRequest(
                process.env.TWILIO_AUTH_TOKEN,
                req.headers['x-twilio-signature'],
                `${process.env.BASE_URL}/api/handle-message`,
                req.body
            );
            if (!isValid) throw new Error('Invalid Twilio signature');
        }

        // 2. Process message
        const userNumber = req.body.From;
        const userMessage = req.body.Body.trim().toLowerCase();
        console.log(`Message from ${userNumber}: "${userMessage}"`);

        // 3. Connect to Neon DB
        neonClient = new Client(process.env.DATABASE_URL);
        await neonClient.connect();

        // 4. Check message count
        const countResult = await neonClient.query(`
            INSERT INTO message_counts (user_number, count)
            VALUES ($1, 1)
            ON CONFLICT (user_number) 
            DO UPDATE SET count = message_counts.count + 1
            RETURNING count
        `, [userNumber]);

        if (countResult.rows[0].count > 30) {
            twiml.message("🚫 Free trial limit reached (30/30). Please upgrade.");
            return res.send(twiml.toString());
        }

        // 5. Get business config (CRITICAL FIX FOR Q&A)
        const configResult = await neonClient.query(`
            SELECT qa_pairs, operating_hours, language 
            FROM business_configs 
            WHERE whatsapp_number = $1
        `, [userNumber]);

        if (configResult.rows.length > 0) {
            const config = configResult.rows[0];
            
            // 6. Check for direct Q&A match (case-insensitive)
            if (config.qa_pairs) {
                // Convert to lowercase keys for matching
                const qaPairsLower = Object.fromEntries(
                    Object.entries(config.qa_pairs).map(([k, v]) => [k.toLowerCase(), v])
                );
                
                if (qaPairsLower[userMessage]) {
                    twiml.message(qaPairsLower[userMessage]);
                    return res.send(twiml.toString());
                }
            }

            // 7. Check business hours if configured
            if (config.operating_hours) {
                const now = new Date();
                const currentTime = now.getHours() * 100 + now.getMinutes();
                const hours = config.operating_hours;
                
                if (hours.opening && hours.closing) {
                    const opening = parseInt(hours.opening.replace(':', ''));
                    const closing = parseInt(hours.closing.replace(':', ''));
                    
                    if (currentTime < opening || currentTime > closing) {
                        twiml.message(`⏳ We're closed now. Hours: ${hours.opening}-${hours.closing}`);
                        return res.send(twiml.toString());
                    }
                }
            }
        }

        // 8. Default responses
        const defaultResponses = {
            'hi': 'Hello! Thanks for messaging us.',
            'hello': 'Hello! How can I help?',
            'help': 'Type your question and we\'ll assist you.',
            'default': "Thank you for your message. We'll respond soon."
        };
        
        twiml.message(defaultResponses[userMessage] || defaultResponses.default);

    } catch (error) {
        console.error('Error:', error);
        twiml.message("⚠️ Temporary system issue. Please try again.");
    } finally {
        if (neonClient) await neonClient.end().catch(console.error);
    }

    return res.send(twiml.toString());
};