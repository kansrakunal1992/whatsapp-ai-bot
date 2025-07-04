// utils/ai-helper.js

/**
 * Language configuration with script detection support
 */
const LANGUAGE_CONFIG = {
  'Hindi': {
    code: 'hi',
    native: [0x0900, 0x097F], // Devanagari range
    example: {
      native: "हिन्दी → नमस्ते",
      roman: "Hindi → Namaste"
    }
  },
  'English': {
    code: 'en',
    example: {
      native: "English → Hello",
      roman: "English → Hello"
    }
  },
  'Bengali': {
    code: 'bn',
    native: [0x0980, 0x09FF],
    example: {
      native: "বাংলা → নমস্কার",
      roman: "Bengali → Nomoskar"
    }
  },
  'Telugu': {
    code: 'te',
    native: [0x0C00, 0x0C7F],
    example: {
      native: "తెలుగు → నమస్కారం",
      roman: "Telugu → Namaskaram"
    }
  },
  'Marathi': {
    code: 'mr',
    native: [0x0900, 0x097F], // Shares Devanagari with Hindi
    example: {
      native: "मराठी → नमस्कार",
      roman: "Marathi → Namaskar"
    }
  },
  'Tamil': {
    code: 'ta',
    native: [0x0B80, 0x0BFF],
    example: {
      native: "தமிழ் → வணக்கம்",
      roman: "Tamil → Vanakkam"
    }
  },
  'Gujarati': {
    code: 'gu',
    native: [0x0A80, 0x0AFF],
    example: {
      native: "ગુજરાતી → નમસ્તે",
      roman: "Gujarati → Namaste"
    }
  },
  'Kannada': {
    code: 'kn',
    native: [0x0C80, 0x0CFF],
    example: {
      native: "ಕನ್ನಡ → ನಮಸ್ಕಾರ",
      roman: "Kannada → Namaskara"
    }
  },
  'Malayalam': {
    code: 'ml',
    native: [0x0D00, 0x0D7F],
    example: {
      native: "മലയാളം → നമസ്കാരം",
      roman: "Malayalam → Namaskaram"
    }
  },
  'Punjabi': {
    code: 'pa',
    native: [0x0A00, 0x0A7F], // Gurmukhi range
    example: {
      native: "ਪੰਜਾਬੀ → ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
      roman: "Punjabi → Sat Sri Akaal"
    }
  },
  'Odia': {
    code: 'or',
    native: [0x0B00, 0x0B7F],
    example: {
      native: "ଓଡ଼ିଆ → ନମସ୍କାର",
      roman: "Odia → Namaskar"
    }
  }
};

/**
 * Get AI response with strict context boundaries
 * @param {string} prompt - User input
 * @param {object} context - Business context
 * @param {string} [languageName='English'] - Language name from LANGUAGE_CONFIG
 * @returns {Promise<string|null>} AI response or null on error
 */
export async function getAIResponse(prompt, context, languageName = 'English') {
  // Validate essential inputs
  if (!prompt?.trim() || !context) {
    console.error('Invalid input: prompt and context are required');
    return null;
  }

  // Get language configuration - MODIFIED: Ensure languageName exists in config
  const langConfig = LANGUAGE_CONFIG[languageName] || LANGUAGE_CONFIG['English'];
  const useNativeScript = langConfig.native 
    ? isNativeScript(prompt, langConfig.native)
    : false;

  // Build strict system instruction with context
  const systemMessage = {
    role: "system",
    content: `You are a customer service assistant for ${context.businessName || 'our business'}.
    
STRICT OPERATING PARAMETERS:
1. BUSINESS DETAILS:
   - Name: ${context.businessName || 'Not specified'}
   - Operating Hours: ${context.operatingHours || 'Not specified'}
   - Location: ${context.location || 'Not specified'}

2. KNOWN ANSWERS:${formatQAPairs(context.knownAnswers)}

3. RESPONSE RULES:
   - ONLY use information from above details
   - NEVER guess or invent answers
   - For unknown queries: "I'll check and respond shortly"
   - Keep responses concise (1-2 sentences max)
   - Maintain professional tone

4. LANGUAGE REQUIREMENTS:
   - Respond in ${languageName}
   - Script: ${useNativeScript ? 'Native' : 'Roman'}
   - Example: ${useNativeScript ? langConfig.example.native : langConfig.example.roman}`
  };

  try {
    const startTime = performance.now();
    console.log(`⚡ AI Request: ${languageName} (${useNativeScript ? 'Native' : 'Roman'})`);

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
          { role: "user", content: prompt.trim() }
        ],
        temperature: 0.3, // Lower for more deterministic responses
        max_tokens: 150, // Limit response length
        top_p: 0.7
      }),
      signal: AbortSignal.timeout(8000) // 8 second timeout
    });

    const latency = Math.round(performance.now() - startTime);

    if (!response.ok) {
      throw new Error(`API Error ${response.status}`);
    }

    const data = await response.json();
    const result = data.choices[0]?.message?.content?.trim();

    console.log(`✅ AI Response (${latency}ms)`);
    return result || "I'll check and respond shortly.";

  } catch (error) {
    console.error('AI Request Failed:', {
      error: error.message,
      language: languageName,
      prompt: prompt.substring(0, 100)
    });
    return "We're experiencing high demand. Please try again later.";
  }
}

// Helper: Format Q&A pairs for system message
function formatQAPairs(qaPairs) {
  if (!qaPairs || typeof qaPairs !== 'object') return '\n  None';
  
  return Object.entries(qaPairs)
    .map(([q, a]) => `\n  Q: ${q}\n  A: ${a}`)
    .join('') + '\n';
}

// Helper: Detect native script characters
function isNativeScript(text, unicodeRange) {
  if (!text || !unicodeRange) return false;
  const [min, max] = unicodeRange;
  return Array.from(text).some(char => {
    const code = char.codePointAt(0);
    return code >= min && code <= max;
  });
}
