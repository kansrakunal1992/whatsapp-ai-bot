export async function getAIResponse(prompt, context, language = 'en') {
  // Validate inputs
  if (!prompt || !context) {
    console.error('Missing required parameters');
    return null;
  }

  // Construct system message in English (processing language)
  const systemMessage = {
    role: "system",
    content: `You are a helpful assistant for ${context.businessName || 'a business'}. 
    Available Context:
    - Operating Hours: ${context.operatingHours || 'Not specified'}
    - Location: ${context.location || 'Not specified'}
    - Known Q&A: ${JSON.stringify(context.qaPairs || {})}
    
    Respond in ${language} only. Be helpful and use the context provided.
    If unsure, say "I'll check and get back to you".`
  };

  try {
    const startTime = Date.now();
    console.log(`🤖 Calling Deepseek API for ${language} response...`);

    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          systemMessage,
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 500
      }),
      timeout: 5000 // 5 second timeout
    });

    const latency = Date.now() - startTime;
    
    if (!response.ok) {
      console.error(`Deepseek API Error: ${response.status} in ${latency}ms`);
      return null;
    }

    const data = await response.json();
    console.log(`✅ Deepseek success (${latency}ms)`);
    
    return data.choices[0]?.message?.content || null;

  } catch (error) {
    console.error('AI Request Failed:', {
      error: error.message,
      prompt: prompt.substring(0, 50),
      language
    });
    return null;
  }
}
