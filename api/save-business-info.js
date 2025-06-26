import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const client = new Client(process.env.DATABASE_URL);
    
    try {
        const { name, type, whatsappNumber, language, operatingHours, location } = req.body;
        
        // Validate required fields
        if (!whatsappNumber) {
            return res.status(400).json({ error: 'WhatsApp number is required' });
        }

        await client.connect();
        
        // Convert operatingHours to JSON string if it isn't already
        const operatingHoursJson = typeof operatingHours === 'string' 
            ? operatingHours 
            : JSON.stringify(operatingHours || {});

        const result = await client.query(`
            INSERT INTO business_configs (
                whatsapp_number,
                business_name,
                business_type,
                language,
                operating_hours,
                location
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (whatsapp_number)
            DO UPDATE SET
                business_name = $2,
                business_type = $3,
                language = $4,
                operating_hours = $5,
                location = $6,
                last_updated = NOW()
            RETURNING whatsapp_number
        `, [
            whatsappNumber,
            name,
            type,
            language,
            operatingHoursJson,
            location
        ]);

        if (!result.rows.length) {
            throw new Error('No rows affected');
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('Database error:', error);
        return res.status(500).json({ 
            error: 'Failed to save business info',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        await client.end().catch(e => console.error('Error closing connection:', e));
    }
};
