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

// Gemini AI integration
async function callGeminiAPI(prompt) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// Generate dynamic questions based on career stage and context
async function generateDynamicQuestions(userProfile) {
  const { careerStage, currentPath, currentSeniorityLevel, existingData } = userProfile;
  
  let contextPrompt = `
    Generate 8-10 relevant career assessment questions for a ${careerStage} professional.
    
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
    1. Return questions as a JSON array
    2. Each question object should have: id, question, type, options (if applicable)
    3. Question types: "multiple_choice", "checkbox", "text", "rating", "ranking"
    4. Make questions contextual and relevant to their career stage
    5. For Trailblazer: Focus on growth, advancement, skill development
    6. For Horizon Changer: Focus on transferable skills, new interests, pivot motivations
    7. For Pathfinder: Focus on discovery, exploration, foundational skills
    
    Example format:
    [
      {
        "id": "q1",
        "question": "What motivates you most in your work?",
        "type": "multiple_choice",
        "options": ["Impact", "Growth", "Stability", "Creativity"]
      }
    ]
  `;

  const response = await callGeminiAPI(contextPrompt);
  
  try {
    // Extract JSON from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error('No valid JSON found in response');
  } catch (error) {
    console.error('Error parsing questions:', error);
    // Fallback to default questions
    return getDefaultQuestions(careerStage);
  }
}

// AI-powered career matching
async function matchCareersWithAI(userResponses, allCareerPaths) {
  const userProfile = JSON.stringify(userResponses, null, 2);
  const careerPathsData = allCareerPaths.map(path => ({
    id: path.$id,
    title: path.title,
    industry: path.industry,
    requiredSkills: path.requiredSkills,
    requiredInterests: path.requiredInterests,
    description: path.description,
    minSalary: path.minSalary,
    maxSalary: path.maxSalary
  }));

  const matchingPrompt = `
    You are an expert career counselor. Analyze the user profile and match them with the most suitable career paths.
    
    User Profile:
    ${userProfile}
    
    Available Career Paths:
    ${JSON.stringify(careerPathsData, null, 2)}
    
    Instructions:
    1. Analyze the user's skills, interests, experience, and career goals
    2. Match them with the top 5-8 most suitable career paths
    3. Consider their career stage (Pathfinder/Trailblazer/Horizon Changer) in your analysis
    4. For each match, provide a compatibility score (0-100) and detailed reasoning
    5. Return results as JSON array with this structure:
    
    [
      {
        "careerPathId": "path_id",
        "compatibilityScore": 85,
        "reasoning": "Detailed explanation of why this is a good match",
        "keyStrengths": ["strength1", "strength2"],
        "developmentAreas": ["area1", "area2"],
        "salaryFit": "excellent|good|fair",
        "timeToTransition": "immediate|3-6 months|6-12 months|1+ years"
      }
    ]
    
    Focus on:
    - Skills alignment (both existing and transferable)
    - Interest alignment
    - Career stage appropriateness
    - Growth potential
    - Realistic transition paths
    - Salary expectations vs reality
  `;

  const response = await callGeminiAPI(matchingPrompt);
  
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const matches = JSON.parse(jsonMatch[0]);
      
      // Enhance matches with full career path data
      return matches.map(match => {
        const fullCareerPath = allCareerPaths.find(path => path.$id === match.careerPathId);
        return {
          ...match,
          careerPath: fullCareerPath
        };
      }).filter(match => match.careerPath); // Remove any matches without valid career paths
    }
    throw new Error('No valid JSON found in response');
  } catch (error) {
    console.error('Error parsing matches:', error);
    throw new Error('Failed to process AI matching results');
  }
}

// Generate personalized career advice
async function generateCareerAdvice(userProfile, matches) {
  const advicePrompt = `
    Based on the user profile and career matches, provide personalized career advice.
    
    User Profile: ${JSON.stringify(userProfile, null, 2)}
    Top Matches: ${JSON.stringify(matches.slice(0, 3), null, 2)}
    
    Provide advice covering:
    1. Next steps for career development
    2. Skills to develop or strengthen
    3. Networking opportunities
    4. Learning resources or certifications to pursue
    5. Timeline and milestones
    
    Keep advice practical, actionable, and encouraging. Format as structured text.
  `;

  return await callGeminiAPI(advicePrompt);
}

// Default questions fallback
function getDefaultQuestions(careerStage) {
  const baseQuestions = [
    {
      id: "q1",
      question: "What type of work environment do you thrive in?",
      type: "multiple_choice",
      options: ["Remote", "Office", "Hybrid", "Field work", "Laboratory"]
    },
    {
      id: "q2",
      question: "Which skills do you most enjoy using?",
      type: "checkbox",
      options: ["Problem solving", "Creative thinking", "Leadership", "Analysis", "Communication"]
    }
  ];

  const stageSpecificQuestions = {
    'Pathfinder': [
      {
        id: "q3",
        question: "What areas are you most curious to explore?",
        type: "checkbox",
        options: ["Technology", "Healthcare", "Business", "Creative Arts", "Science"]
      }
    ],
    'Trailblazer': [
      {
        id: "q3",
        question: "What aspects of your current role do you want to expand?",
        type: "checkbox",
        options: ["Leadership", "Technical expertise", "Strategic thinking", "Team management"]
      }
    ],
    'Horizon Changer': [
      {
        id: "q3",
        question: "What's driving your desire to change career paths?",
        type: "multiple_choice",
        options: ["Better work-life balance", "Higher salary", "More meaningful work", "New challenges"]
      }
    ]
  };

  return [...baseQuestions, ...(stageSpecificQuestions[careerStage] || [])];
}

// Main function handler
export default async ({ req, res, log, error }) => {
  try {
    const { action, data } = JSON.parse(req.body);
    
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('Gemini API key not configured');
    }

    switch (action) {
      case 'generateQuestions':
        const questions = await generateDynamicQuestions(data.userProfile);
        return res.json({ success: true, questions });

      case 'matchCareers':
        // Fetch all career paths
        const careerPaths = await databases.listDocuments(
          config.databaseId,
          config.careerPathsCollectionId,
          [Query.limit(100)]
        );

        const matches = await matchCareersWithAI(
          data.userResponses,
          careerPaths.documents
        );

        // Generate personalized advice
        const advice = await generateCareerAdvice(
          data.userResponses,
          matches
        );

        return res.json({ success: true, matches, advice });

      case 'updateUserProfile':
        // Update user profile with survey responses
        const updatedUser = await databases.updateDocument(
          config.databaseId,
          config.talentsCollectionId,
          data.userId,
          {
            ...data.profileUpdates,
            testTaken: true,
            $updatedAt: new Date().toISOString()
          }
        );

        return res.json({ success: true, user: updatedUser });

      default:
        throw new Error('Invalid action');
    }

  } catch (err) {
    error('Function error:', err);
    return res.json({ success: false, error: err.message }, 500);
  }
};