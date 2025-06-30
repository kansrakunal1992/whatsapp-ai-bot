import { getAIResponse } from '../utils/ai-helper.js';

export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { question, currentAnswer, businessContext, language } = req.body;
  
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ 
      error: "Valid question is required",
      answer: currentAnswer 
    });
  }

  // Validate business context structure
  const validatedContext = {
    name: businessContext?.name || 'Business',
    workingHours: businessContext?.workingHours || 'our business hours',
    location: businessContext?.location || 'our location',
    priceRange: businessContext?.priceRange || 'various prices',
    services: businessContext?.services || 'our services',
    discountGroups: businessContext?.discountGroups || 'eligible customers',
    cancellationNotice: businessContext?.cancellationNotice || '24 hours',
    phoneNumber: businessContext?.phoneNumber || 'our contact number',
    knownAnswers: businessContext?.knownAnswers || {}
  };

  try {
    // Prepare the AI prompt with strict instructions
    const prompt = `As a customer service representative for ${validatedContext.name}, improve this response to be more natural while maintaining professionalism. Follow these rules:
    
1. PRESERVE ALL KEY INFORMATION from the current answer
2. ADAPT TO LANGUAGE: ${language || 'English'}
3. BUSINESS CONTEXT:
   - Hours: ${validatedContext.workingHours}
   - Location: ${validatedContext.location}
   - Prices: ${validatedContext.priceRange}
   - Services: ${validatedContext.services}
4. CURRENT QUESTION: "${question}"
5. CURRENT ANSWER: "${currentAnswer}"

Provide ONLY the improved version without additional commentary.`;

    // Get AI-generated response
    const improvedAnswer = await getAIResponse(
      prompt,
      validatedContext,
      language
    );

    // Validate and sanitize the response
    const finalAnswer = improvedAnswer?.trim() || currentAnswer;
    
    return res.status(200).json({ 
      answer: finalAnswer.substring(0, 500) // Limit response length
    });

  } catch (error) {
    console.error("Regeneration error:", {
      error: error.message,
      question: question.substring(0, 50),
      language,
      businessName: validatedContext.name
    });
    
    return res.status(500).json({ 
      error: "Failed to improve answer. Using original version.",
      answer: currentAnswer 
    });
  }
};