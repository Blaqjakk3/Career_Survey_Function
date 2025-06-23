// main.js - Appwrite Function for AI Career Matching
import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Appwrite client
const client = new Client()
  .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
  .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const config = {
  databaseId: 'career4me',
  talentsCollectionId: 'talents',
  careerPathsCollectionId: 'careerPaths',
};

// Enhanced Gemini AI integration with timeout and retry
async function callGeminiAPIWithTimeout(prompt, timeoutMs = 25000) {
  try {
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-1.5-flash',
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 2048,
      },
    });
    
    // Create a timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Gemini API timeout')), timeoutMs);
    });
    
    // Race between API call and timeout
    const apiPromise = model.generateContent(prompt);
    const result = await Promise.race([apiPromise, timeoutPromise]);
    
    return result.response.text();
  } catch (error) {
    console.error('Gemini API error:', error);
    throw new Error(`AI service error: ${error.message}`);
  }
}

// Generate dynamic questions with fallback
async function generateDynamicQuestions(userProfile) {
  const { careerStage, currentPath, currentSeniorityLevel, existingData } = userProfile;
  
  let contextPrompt = `
    Generate 6-8 relevant career assessment questions for a ${careerStage} professional.
    
    Career Stage Context:
    - Pathfinder: Someone new to career life, exploring and learning
    - Trailblazer: Someone with an established career looking to grow
    - Horizon Changer: Someone looking to pivot to a different career path
    
    Current Profile:
    - Career Stage: ${careerStage}
    ${currentPath ? `- Current Career Path: ${currentPath}` : ''}
    ${currentSeniorityLevel ? `- Current Seniority: ${currentSeniorityLevel}` : ''}
    ${existingData?.skills?.length ? `- Existing Skills: ${existingData.skills.join(', ')}` : ''}
    ${existingData?.interests?.length ? `- Existing Interests: ${existingData.interests.join(', ')}` : ''}
    
    Requirements:
    1. Return ONLY a valid JSON array, no other text
    2. Each question object: {"id": "q1", "question": "text", "type": "multiple_choice", "options": ["A", "B"]}
    3. Question types: "multiple_choice", "checkbox", "text", "rating"
    4. Keep questions concise and relevant
    5. Maximum 4 options per multiple choice question
    
    Example format:
    [
      {
        "id": "q1",
        "question": "What motivates you most in your work?",
        "type": "multiple_choice",
        "options": ["Impact", "Growth", "Stability", "Creativity"]
      },
      {
        "id": "q2",
        "question": "Which skills do you enjoy using?",
        "type": "checkbox",
        "options": ["Problem solving", "Communication", "Leadership", "Analysis"]
      }
    ]
  `;

  try {
    const response = await callGeminiAPIWithTimeout(contextPrompt, 20000);
    
    // Clean and extract JSON
    const cleanedResponse = response.trim();
    const jsonMatch = cleanedResponse.match(/\[[\s\S]*\]/);
    
    if (jsonMatch) {
      const questions = JSON.parse(jsonMatch[0]);
      // Validate structure
      if (Array.isArray(questions) && questions.length > 0 && questions[0].id) {
        return questions;
      }
    }
    
    throw new Error('Invalid JSON structure');
  } catch (error) {
    console.error('Error generating questions:', error);
    // Return fallback questions
    return getDefaultQuestions(careerStage);
  }
}

// Optimized AI career matching with reduced payload
async function matchCareersWithAI(userResponses, allCareerPaths) {
  try {
    // Limit career paths to prevent payload issues
    const limitedPaths = allCareerPaths.slice(0, 20);
    
    const userProfile = {
      careerStage: userResponses.careerStage,
      responses: userResponses,
      timestamp: userResponses.timestamp
    };
    
    const careerPathsData = limitedPaths.map(path => ({
      id: path.$id,
      title: path.title,
      industry: path.industry,
      requiredSkills: path.requiredSkills?.slice(0, 5) || [],
      requiredInterests: path.requiredInterests?.slice(0, 5) || [],
      description: path.description?.substring(0, 200) || '',
      minSalary: path.minSalary,
      maxSalary: path.maxSalary
    }));

    const matchingPrompt = `
      You are a career counselor. Match the user with suitable career paths based on their profile.
      
      User Profile: ${JSON.stringify(userProfile)}
      
      Career Paths: ${JSON.stringify(careerPathsData)}
      
      Instructions:
      1. Return ONLY a valid JSON array, no other text
      2. Match top 5 most suitable career paths
      3. Provide compatibility score (0-100) and brief reasoning
      4. Structure: [{"careerPathId": "id", "compatibilityScore": 85, "reasoning": "brief explanation", "keyStrengths": ["strength1"], "developmentAreas": ["area1"], "salaryFit": "good", "timeToTransition": "3-6 months"}]
      5. Keep reasoning under 100 characters
      6. salaryFit: "excellent", "good", or "fair"
      7. timeToTransition: "immediate", "3-6 months", "6-12 months", or "1+ years"
    `;

    const response = await callGeminiAPIWithTimeout(matchingPrompt, 25000);
    
    const cleanedResponse = response.trim();
    const jsonMatch = cleanedResponse.match(/\[[\s\S]*\]/);
    
    if (jsonMatch) {
      const matches = JSON.parse(jsonMatch[0]);
      
      // Enhance matches with full career path data
      return matches.map(match => {
        const fullCareerPath = allCareerPaths.find(path => path.$id === match.careerPathId);
        return {
          ...match,
          careerPath: fullCareerPath
        };
      }).filter(match => match.careerPath);
    }
    
    throw new Error('Invalid match response');
  } catch (error) {
    console.error('Error in AI matching:', error);
    // Return fallback matches
    return getFallbackMatches(allCareerPaths.slice(0, 5));
  }
}

// Simple career advice generation
async function generateCareerAdvice(userProfile, matches) {
  try {
    const advicePrompt = `
      Based on the user's career stage "${userProfile.careerStage}" and top career matches, provide 3-4 sentences of practical career advice.
      
      Top Matches: ${matches.slice(0, 2).map(m => m.careerPath?.title).join(', ')}
      
      Keep advice:
      - Under 200 words
      - Practical and actionable
      - Encouraging
      - Focused on next steps
      
      Return only the advice text, no formatting.
    `;

    return await callGeminiAPIWithTimeout(advicePrompt, 15000);
  } catch (error) {
    console.error('Error generating advice:', error);
    return getDefaultAdvice(userProfile.careerStage);
  }
}

// Fallback functions
function getDefaultQuestions(careerStage) {
  const baseQuestions = [
    {
      id: "q1",
      question: "What type of work environment do you prefer?",
      type: "multiple_choice",
      options: ["Remote", "Office", "Hybrid", "Field work"]
    },
    {
      id: "q2",
      question: "Which skills do you enjoy using most?",
      type: "checkbox",
      options: ["Problem solving", "Communication", "Leadership", "Analysis"]
    },
    {
      id: "q3",
      question: "What motivates you most in your work?",
      type: "multiple_choice",
      options: ["Impact", "Growth", "Stability", "Creativity"]
    }
  ];

  const stageQuestions = {
    'Pathfinder': [
      {
        id: "q4",
        question: "Which areas interest you most?",
        type: "checkbox",
        options: ["Technology", "Healthcare", "Business", "Creative Arts"]
      }
    ],
    'Trailblazer': [
      {
        id: "q4",
        question: "What aspects do you want to develop?",
        type: "checkbox",
        options: ["Leadership", "Technical skills", "Strategy", "Management"]
      }
    ],
    'Horizon Changer': [
      {
        id: "q4",
        question: "What drives your career change?",
        type: "multiple_choice",
        options: ["Better balance", "Higher salary", "More meaning", "New challenges"]
      }
    ]
  };

  return [...baseQuestions, ...(stageQuestions[careerStage] || [])];
}

function getFallbackMatches(careerPaths) {
  return careerPaths.slice(0, 3).map((path, index) => ({
    careerPathId: path.$id,
    compatibilityScore: 75 - (index * 5),
    reasoning: "Based on general career compatibility assessment",
    keyStrengths: ["Adaptability", "Learning ability"],
    developmentAreas: ["Skill development", "Experience"],
    salaryFit: "good",
    timeToTransition: "6-12 months",
    careerPath: path
  }));
}

function getDefaultAdvice(careerStage) {
  const advice = {
    'Pathfinder': "Focus on exploring different career paths through internships, informational interviews, and skill-building courses. Take advantage of entry-level opportunities to gain experience and discover your interests.",
    'Trailblazer': "Leverage your existing experience to advance in your current field. Consider pursuing leadership roles, specialized certifications, or mentoring others to accelerate your career growth.",
    'Horizon Changer': "Identify transferable skills from your current role and create a transition plan. Network in your target industry and consider additional training to bridge any skill gaps."
  };
  
  return advice[careerStage] || "Continue developing your skills and exploring opportunities that align with your interests and goals.";
}

// Main function handler with better error handling
export default async ({ req, res, log, error }) => {
  try {
    // Set timeout for the entire function
    const startTime = Date.now();
    const FUNCTION_TIMEOUT = 55000; // 55 seconds (Appwrite timeout is 60s)
    
    log('Function started');
    
    const { action, data } = JSON.parse(req.body);
    
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('Gemini API key not configured');
    }

    // Check remaining time before each operation
    const checkTimeout = () => {
      if (Date.now() - startTime > FUNCTION_TIMEOUT) {
        throw new Error('Function timeout approaching');
      }
    };

    switch (action) {
      case 'generateQuestions':
        checkTimeout();
        log('Generating questions for user profile');
        const questions = await generateDynamicQuestions(data.userProfile);
        log(`Generated ${questions.length} questions`);
        return res.json({ success: true, questions });

      case 'matchCareers':
        checkTimeout();
        log('Starting career matching process');
        
        // Fetch career paths with timeout
        const careerPaths = await databases.listDocuments(
          config.databaseId,
          config.careerPathsCollectionId,
          [Query.limit(50)] // Reduced limit for faster processing
        );
        
        log(`Found ${careerPaths.documents.length} career paths`);
        checkTimeout();
        
        // Process matches
        const matches = await matchCareersWithAI(
          data.userResponses,
          careerPaths.documents
        );
        
        log(`Generated ${matches.length} matches`);
        checkTimeout();
        
        // Generate advice
        const advice = await generateCareerAdvice(
          data.userResponses,
          matches
        );
        
        log('Career matching completed successfully');
        return res.json({ success: true, matches, advice });

      case 'updateUserProfile':
        checkTimeout();
        log(`Updating profile for user: ${data.userId}`);
        
        const updatedUser = await databases.updateDocument(
          config.databaseId,
          config.talentsCollectionId,
          data.userId,
          {
            ...data.profileUpdates,
            testTaken: true,
            lastUpdated: new Date().toISOString()
          }
        );
        
        log('Profile updated successfully');
        return res.json({ success: true, user: updatedUser });

      default:
        throw new Error(`Invalid action: ${action}`);
    }

  } catch (err) {
    error('Function error:', err.message);
    error('Stack trace:', err.stack);
    
    // Return appropriate error response
    const errorResponse = {
      success: false,
      error: err.message,
      timestamp: new Date().toISOString()
    };
    
    return res.json(errorResponse, 500);
  }
};