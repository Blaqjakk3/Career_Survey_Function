import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

export default async function (context) {
  try {
    // Access environment variables correctly for Appwrite Cloud Functions
    const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
    const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
    const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const DATABASE_ID = process.env.DATABASE_ID || 'career4me';
    const TALENTS_COLLECTION_ID = process.env.TALENTS_COLLECTION_ID || 'talents';
    const CAREER_PATHS_COLLECTION_ID = process.env.CAREER_PATHS_COLLECTION_ID || 'careerPaths';

    // Get user ID and survey answers from the request payload
    let userId = null;
    let surveyAnswers = null;
    
    // Parse the request payload
    try {
      const payload = JSON.parse(context.req.body || '{}');
      userId = payload.userId;
      surveyAnswers = payload.surveyAnswers;
    } catch (e) {
      context.error('Failed to parse request payload:', e);
    }

    // Try to get user ID from JWT token in headers if not in payload
    if (!userId) {
      try {
        if (context.req.headers['x-appwrite-user-id']) {
          userId = context.req.headers['x-appwrite-user-id'];
        } else if (context.req.headers['authorization']) {
          const userClient = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT_ID);
          
          const authHeader = context.req.headers['authorization'];
          if (authHeader.startsWith('Bearer ')) {
            const sessionId = authHeader.substring(7);
            userClient.setSession(sessionId);
            
            const { Account } = await import('node-appwrite');
            const userAccount = new Account(userClient);
            const user = await userAccount.get();
            userId = user.$id;
          }
        }
      } catch (authError) {
        context.log('Auth error:', authError);
      }
    }

    context.log('Environment variables loaded:', {
      hasEndpoint: !!APPWRITE_ENDPOINT,
      hasProjectId: !!APPWRITE_PROJECT_ID,
      hasApiKey: !!APPWRITE_API_KEY,
      hasGeminiKey: !!GEMINI_API_KEY,
      userId: userId || 'not found',
      hasSurveyAnswers: !!surveyAnswers
    });

    // Validate required environment variables
    if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY || !GEMINI_API_KEY) {
      context.error("Missing required environment variables");
      throw new Error("Missing required environment variables");
    }

    if (!userId) {
      context.error("No user ID found in request context or payload");
      throw new Error("User authentication required");
    }

    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(APPWRITE_ENDPOINT)
      .setProject(APPWRITE_PROJECT_ID)
      .setKey(APPWRITE_API_KEY);

    // Initialize Gemini AI with optimized configuration
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.6,
        topP: 0.8,
        topK: 20,
        maxOutputTokens: 2048, // Limit output for faster response
      }
    });

    const databases = new Databases(client);

    context.log('Fetching user data for userId:', userId);

    // Get user data
    const user = await databases.listDocuments(
      DATABASE_ID,
      TALENTS_COLLECTION_ID,
      [Query.equal("talentId", userId)]
    );

    if (user.documents.length === 0) {
      context.error("User not found for userId:", userId);
      throw new Error("User not found");
    }

    const userData = user.documents[0];
    const careerStage = userData.careerStage;

    context.log('User data found:', {
      careerStage,
      hasSurveyAnswers: !!surveyAnswers
    });

    // Function to map survey answers to user profile data
    const mapSurveyAnswersToProfile = (answers, careerStage) => {
      const profile = {
        careerStage,
        education: '',
        program: '',
        currentSkills: [],
        interestedSkills: [],
        interests: [],
        interestedFields: [],
        workEnvironment: '',
        currentPath: '',
        yearsExperience: '',
        seniorityLevel: '',
        careerGoals: '',
        reasonForChange: '',
        changeUrgency: ''
      };

      // Map common fields
      if (answers.educationLevel) profile.education = answers.educationLevel;
      if (answers.program) profile.program = answers.program;
      
      // Handle arrays
      if (answers.currentSkills) {
        profile.currentSkills = Array.isArray(answers.currentSkills) 
          ? answers.currentSkills 
          : [answers.currentSkills];
      }
      if (answers.interestedSkills) {
        profile.interestedSkills = Array.isArray(answers.interestedSkills) 
          ? answers.interestedSkills 
          : [answers.interestedSkills];
      }
      if (answers.mainInterests) {
        profile.interests = Array.isArray(answers.mainInterests) 
          ? answers.mainInterests 
          : [answers.mainInterests];
      }
      if (answers.interestedFields) {
        profile.interestedFields = Array.isArray(answers.interestedFields) 
          ? answers.interestedFields 
          : [answers.interestedFields];
      }

      // Stage-specific mappings
      if (careerStage === 'Pathfinder') {
        if (answers.workEnvironment) profile.workEnvironment = answers.workEnvironment;
      } else if (careerStage === 'Trailblazer') {
        if (answers.currentPath) profile.currentPath = answers.currentPath;
        if (answers.yearsExperience) profile.yearsExperience = answers.yearsExperience;
        if (answers.seniorityLevel) profile.seniorityLevel = answers.seniorityLevel;
        if (answers.careerGoals) profile.careerGoals = answers.careerGoals;
      } else if (careerStage === 'Horizon Changer') {
        if (answers.currentPath) profile.currentPath = answers.currentPath;
        if (answers.yearsExperience) profile.yearsExperience = answers.yearsExperience;
        if (answers.seniorityLevel) profile.seniorityLevel = answers.seniorityLevel;
        if (answers.currentWorkEnvironment) profile.currentWorkEnvironment = answers.currentWorkEnvironment;
        if (answers.preferredWorkEnvironment) profile.preferredWorkEnvironment = answers.preferredWorkEnvironment;
        if (answers.reasonForChange) profile.reasonForChange = answers.reasonForChange;
        if (answers.changeUrgency) profile.changeUrgency = answers.changeUrgency;
      }

      return profile;
    };

    // Get user profile
    let userProfile;
    if (surveyAnswers && Object.keys(surveyAnswers).length > 0) {
      context.log('Using survey answers for recommendation');
      userProfile = mapSurveyAnswersToProfile(surveyAnswers, careerStage);
      
      // Update user data in background (don't wait for it)
      const updateData = {};
      if (surveyAnswers.currentSkills) {
        updateData.skills = Array.isArray(surveyAnswers.currentSkills) 
          ? surveyAnswers.currentSkills 
          : [surveyAnswers.currentSkills];
      }
      if (surveyAnswers.mainInterests) {
        updateData.interests = Array.isArray(surveyAnswers.mainInterests) 
          ? surveyAnswers.mainInterests 
          : [surveyAnswers.mainInterests];
      }
      
      if (Object.keys(updateData).length > 0) {
        databases.updateDocument(DATABASE_ID, TALENTS_COLLECTION_ID, userData.$id, updateData)
          .catch(err => context.log('Background update error:', err));
      }
    } else {
      context.log('Using stored user data for recommendation');
      userProfile = {
        careerStage,
        education: userData.degrees?.join(', ') || 'Not specified',
        currentSkills: userData.skills || [],
        interests: userData.interests || [],
        interestedFields: userData.interestedFields || [],
        currentPath: userData.currentPath || 'Not specified',
        seniorityLevel: userData.currentSeniorityLevel || 'Not specified'
      };
    }

    // Smart filtering function to reduce career paths to manageable number
    const filterRelevantCareerPaths = (allPaths, userProfile) => {
      const userSkills = [...(userProfile.currentSkills || []), ...(userProfile.interestedSkills || [])];
      const userInterests = userProfile.interests || [];
      const userFields = userProfile.interestedFields || [];
      
      // Score each career path
      const scoredPaths = allPaths.map(path => {
        let score = 0;
        
        // Skills matching
        const pathSkills = path.requiredSkills || [];
        const skillMatches = pathSkills.filter(skill => 
          userSkills.some(userSkill => 
            userSkill.toLowerCase().includes(skill.toLowerCase()) ||
            skill.toLowerCase().includes(userSkill.toLowerCase())
          )
        ).length;
        score += skillMatches * 3;
        
        // Interest matching
        const pathInterests = path.requiredInterests || [];
        const interestMatches = pathInterests.filter(interest =>
          userInterests.some(userInterest =>
            userInterest.toLowerCase().includes(interest.toLowerCase()) ||
            interest.toLowerCase().includes(userInterest.toLowerCase())
          )
        ).length;
        score += interestMatches * 2;
        
        // Field matching
        const industryMatch = userFields.some(field =>
          path.industry?.toLowerCase().includes(field.toLowerCase()) ||
          field.toLowerCase().includes(path.industry?.toLowerCase() || '') ||
          path.title?.toLowerCase().includes(field.toLowerCase()) ||
          path.description?.toLowerCase().includes(field.toLowerCase())
        );
        if (industryMatch) score += 2;
        
        // Education alignment
        if (path.suggestedDegrees && userProfile.education && userProfile.education !== 'Not specified') {
          const educationMatch = path.suggestedDegrees.some(degree =>
            userProfile.education.toLowerCase().includes(degree.toLowerCase()) ||
            userProfile.program?.toLowerCase().includes(degree.toLowerCase())
          );
          if (educationMatch) score += 1;
        }
        
        return { ...path, matchScore: score };
      });
      
      // Sort by score and take top candidates, but ensure diversity
      const topScored = scoredPaths.sort((a, b) => b.matchScore - a.matchScore);
      const selected = [];
      const usedIndustries = new Set();
      
      // First pass: take top scorers with different industries
      for (const path of topScored) {
        if (selected.length >= 20) break; // Limit to 20 for AI processing
        if (!usedIndustries.has(path.industry) || selected.length < 10) {
          selected.push(path);
          if (path.industry) usedIndustries.add(path.industry);
        }
      }
      
      // Second pass: fill remaining slots with any high-scoring paths
      for (const path of topScored) {
        if (selected.length >= 20) break;
        if (!selected.some(p => p.$id === path.$id)) {
          selected.push(path);
        }
      }
      
      return selected;
    };

    // Get filtered career paths (use smart batching)
    context.log('Fetching career paths...');
    const careerPathsBatch1 = await databases.listDocuments(
      DATABASE_ID,
      CAREER_PATHS_COLLECTION_ID,
      [Query.limit(100)]
    );
    
    let allCareerPaths = careerPathsBatch1.documents;
    
    // If we got 100, there might be more
    if (careerPathsBatch1.documents.length === 100) {
      const careerPathsBatch2 = await databases.listDocuments(
        DATABASE_ID,
        CAREER_PATHS_COLLECTION_ID,
        [Query.limit(100), Query.offset(100)]
      );
      allCareerPaths = allCareerPaths.concat(careerPathsBatch2.documents);
    }

    context.log('Total career paths found:', allCareerPaths.length);

    // Filter to most relevant paths
    const relevantPaths = filterRelevantCareerPaths(allCareerPaths, userProfile);
    context.log('Filtered to relevant paths:', relevantPaths.length);

    // Prepare concise prompt for faster processing
    let prompt = `Based on the user profile, recommend the top 5 career paths from the provided list. User is a ${careerStage}.\n\n`;

    // Add user profile based on career stage
    if (careerStage === "Pathfinder") {
      prompt += `User: Education: ${userProfile.education}, Skills: ${userProfile.currentSkills.join(', ')}, Interests: ${userProfile.interests.join(', ')}, Fields: ${userProfile.interestedFields.join(', ')}\n\n`;
    } else if (careerStage === "Trailblazer") {
      prompt += `User: Current Path: ${userProfile.currentPath}, Experience: ${userProfile.yearsExperience}, Skills: ${userProfile.currentSkills.join(', ')}, Interests: ${userProfile.interests.join(', ')}, Goals: ${userProfile.careerGoals}\n\n`;
    } else if (careerStage === "Horizon Changer") {
      prompt += `User: Current Path: ${userProfile.currentPath}, Experience: ${userProfile.yearsExperience}, Skills: ${userProfile.currentSkills.join(', ')}, Interests: ${userProfile.interests.join(', ')}, Reason for Change: ${userProfile.reasonForChange}\n\n`;
    }

    prompt += `Career Paths:\n`;
    relevantPaths.forEach((path, index) => {
      prompt += `${index + 1}. ${path.title} (ID: ${path.$id}) - ${path.industry || 'General'}\n`;
      prompt += `   Skills: ${path.requiredSkills?.slice(0, 3).join(', ') || 'None'}\n`;
      prompt += `   Interests: ${path.requiredInterests?.slice(0, 3).join(', ') || 'None'}\n\n`;
    });

    prompt += `Return JSON with exactly 5 recommendations:
    {
      "recommendations": [
        {
          "pathId": "id",
          "title": "title",
          "matchScore": 85,
          "reason": "Brief reason for match",
          "improvementAreas": ["skill1", "skill2"]
        }
      ],
      "generalAdvice": "Brief career advice"
    }`;

    context.log('Calling Gemini AI with', relevantPaths.length, 'filtered career paths...');

    // Get AI response
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    context.log('AI response received, length:', text.length);

    // Parse JSON response
    let jsonResponse;
    try {
      const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      jsonResponse = JSON.parse(cleanedText);
    } catch (e) {
      context.error("Failed to parse AI response:", text);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          jsonResponse = JSON.parse(jsonMatch[0]);
        } catch (e2) {
          throw new Error("Failed to parse AI response as JSON");
        }
      } else {
        throw new Error("No valid JSON found in AI response");
      }
    }

    // Validate response
    if (!jsonResponse.recommendations || !Array.isArray(jsonResponse.recommendations)) {
      throw new Error("Invalid response structure from AI");
    }

    if (jsonResponse.recommendations.length < 5) {
      context.log("AI provided fewer than 5 recommendations:", jsonResponse.recommendations.length);
    }

    // Validate path IDs exist
    const validRecommendations = jsonResponse.recommendations.filter(rec => 
      relevantPaths.some(path => path.$id === rec.pathId)
    );

    if (validRecommendations.length === 0) {
      throw new Error("No valid recommendations from AI");
    }

    context.log('Updating user testTaken status...');

    // Update user status (don't wait for this)
    databases.updateDocument(DATABASE_ID, TALENTS_COLLECTION_ID, userData.$id, { testTaken: true })
      .catch(err => context.log('Error updating testTaken:', err));

    // Prepare response
    const responseData = {
      success: true,
      recommendations: validRecommendations.slice(0, 5), // Ensure max 5
      generalAdvice: jsonResponse.generalAdvice || "Continue developing your skills and exploring opportunities in your areas of interest.",
      careerStage,
      totalPathsAnalyzed: relevantPaths.length,
      totalPathsInDatabase: allCareerPaths.length
    };

    context.log('Career match completed successfully');
    return context.res.json(responseData);

  } catch (error) {
    context.error("Error in careerMatch function:", error);
    
    const errorResponse = {
      success: false,
      error: error.message || "An unknown error occurred"
    };
    
    return context.res.json(errorResponse);
  }
}