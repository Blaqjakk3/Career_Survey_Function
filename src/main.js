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
          // If we have an auth header, we can get the user from the client
          const userClient = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT_ID);
          
          // Set the session from the authorization header
          const authHeader = context.req.headers['authorization'];
          if (authHeader.startsWith('Bearer ')) {
            const sessionId = authHeader.substring(7);
            userClient.setSession(sessionId);
            
            const { Account } = require('node-appwrite');
            const userAccount = new Account(userClient);
            const user = await userAccount.get();
            userId = user.$id;
          }
        }
      } catch (authError) {
        context.log('Auth error:', authError);
      }
    }

    // Use context.log for better logging experience
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
      context.error("Missing required environment variables", {
        APPWRITE_ENDPOINT: !!APPWRITE_ENDPOINT,
        APPWRITE_PROJECT_ID: !!APPWRITE_PROJECT_ID,
        APPWRITE_API_KEY: !!APPWRITE_API_KEY,
        GEMINI_API_KEY: !!GEMINI_API_KEY
      });
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

    // Initialize Gemini AI
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const databases = new Databases(client);

    context.log('Fetching user data for userId:', userId);

    // Get user data for career stage and basic info
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

    // Get all career paths
    const careerPaths = await databases.listDocuments(
      DATABASE_ID,
      CAREER_PATHS_COLLECTION_ID
    );

    if (careerPaths.documents.length === 0) {
      context.error("No career paths found in database");
      throw new Error("No career paths found in database");
    }

    context.log('Career paths found:', careerPaths.documents.length);

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

      // Map common fields across all career stages
      if (answers.educationLevel) profile.education = answers.educationLevel;
      if (answers.program) profile.program = answers.program;
      
      // Handle skills - convert single answers to arrays for consistency
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

    // Use survey answers if provided, otherwise fall back to stored user data
    let userProfile;
    if (surveyAnswers && Object.keys(surveyAnswers).length > 0) {
      context.log('Using survey answers for recommendation');
      userProfile = mapSurveyAnswersToProfile(surveyAnswers, careerStage);
      
      // Update the talents collection with the new survey data
      const updateData = {};
      
      // Map survey answers to database fields where appropriate
      if (surveyAnswers.educationLevel && !['High School', 'Some College'].includes(surveyAnswers.educationLevel)) {
        if (surveyAnswers.program && !updateData.degrees) updateData.degrees = [surveyAnswers.program];
      }
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
      if (surveyAnswers.interestedFields) {
        updateData.interestedFields = Array.isArray(surveyAnswers.interestedFields) 
          ? surveyAnswers.interestedFields 
          : [surveyAnswers.interestedFields];
      }
      if (surveyAnswers.currentPath) updateData.currentPath = surveyAnswers.currentPath;
      if (surveyAnswers.seniorityLevel) updateData.currentSeniorityLevel = surveyAnswers.seniorityLevel;
      
      // Update the user document with relevant survey data
      if (Object.keys(updateData).length > 0) {
        try {
          await databases.updateDocument(
            DATABASE_ID,
            TALENTS_COLLECTION_ID,
            userData.$id,
            updateData
          );
          context.log('Updated user profile with survey data');
        } catch (updateError) {
          context.log('Error updating user profile:', updateError);
        }
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

    // Prepare prompt based on career stage and user profile
    let prompt = `Based on the following user profile, recommend the top 3 career paths from the provided list. `;
    prompt += `User is a ${careerStage}.\n\n`;

    if (careerStage === "Pathfinder") {
      prompt += `User details:
      - Education: ${userProfile.education || 'Not specified'}
      - Program: ${userProfile.program || 'Not specified'}
      - Current Skills: ${userProfile.currentSkills.join(', ') || 'Not specified'}
      - Interested Skills: ${userProfile.interestedSkills.join(', ') || 'Not specified'}
      - Interests: ${userProfile.interests.join(', ') || 'Not specified'}
      - Interested Fields: ${userProfile.interestedFields.join(', ') || 'Not specified'}
      - Preferred Work Environment: ${userProfile.workEnvironment || 'Not specified'}
      `;
    } else if (careerStage === "Trailblazer") {
      prompt += `User details:
      - Current Path: ${userProfile.currentPath || 'Not specified'}
      - Years of Experience: ${userProfile.yearsExperience || 'Not specified'}
      - Seniority Level: ${userProfile.seniorityLevel || 'Not specified'}
      - Education: ${userProfile.education || 'Not specified'}
      - Program: ${userProfile.program || 'Not specified'}
      - Current Skills: ${userProfile.currentSkills.join(', ') || 'Not specified'}
      - Interested Skills: ${userProfile.interestedSkills.join(', ') || 'Not specified'}
      - Interests: ${userProfile.interests.join(', ') || 'Not specified'}
      - Interested Fields: ${userProfile.interestedFields.join(', ') || 'Not specified'}
      - Career Goals: ${userProfile.careerGoals || 'Not specified'}
      `;
    } else if (careerStage === "Horizon Changer") {
      prompt += `User details:
      - Current Path: ${userProfile.currentPath || 'Not specified'}
      - Years of Experience: ${userProfile.yearsExperience || 'Not specified'}
      - Seniority Level: ${userProfile.seniorityLevel || 'Not specified'}
      - Education: ${userProfile.education || 'Not specified'}
      - Program: ${userProfile.program || 'Not specified'}
      - Current Skills: ${userProfile.currentSkills.join(', ') || 'Not specified'}
      - Interested Skills: ${userProfile.interestedSkills.join(', ') || 'Not specified'}
      - Interests: ${userProfile.interests.join(', ') || 'Not specified'}
      - Interested Fields: ${userProfile.interestedFields.join(', ') || 'Not specified'}
      - Current Work Environment: ${userProfile.currentWorkEnvironment || 'Not specified'}
      - Preferred Work Environment: ${userProfile.preferredWorkEnvironment || 'Not specified'}
      - Reason for Change: ${userProfile.reasonForChange || 'Not specified'}
      - Change Urgency: ${userProfile.changeUrgency || 'Not specified'}
      `;
    }

    prompt += `\nAvailable Career Paths:\n`;
    careerPaths.documents.forEach(path => {
      prompt += `- ${path.title} (ID: ${path.$id}): ${path.description}\n`;
      prompt += `  Required Skills: ${path.requiredSkills?.join(', ') || 'None'}\n`;
      prompt += `  Required Interests: ${path.requiredInterests?.join(', ') || 'None'}\n`;
    });

    prompt += `\nProvide your response in JSON format with this structure:
    {
      "recommendations": [
        {
          "pathId": "career_path_id_1",
          "title": "Career Path Title 1",
          "matchScore": 90,
          "reason": "Detailed explanation why this is a good match",
          "improvementAreas": ["skill1", "skill2"]
        },
        {
          "pathId": "career_path_id_2",
          "title": "Career Path Title 2",
          "matchScore": 80,
          "reason": "Detailed explanation why this is a good match",
          "improvementAreas": ["skill1", "skill2"]
        },
        {
          "pathId": "career_path_id_3",
          "title": "Career Path Title 3",
          "matchScore": 75,
          "reason": "Detailed explanation why this is a good match",
          "improvementAreas": ["skill1", "skill2"]
        }
      ],
      "generalAdvice": "Overall career advice based on the user's profile"
    }`;

    context.log('Calling Gemini AI...');

    // Get AI response
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    context.log('Gemini AI response received, length:', text.length);

    // Parse the JSON response
    let jsonResponse;
    try {
      // Clean the response text to remove any markdown formatting
      const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      jsonResponse = JSON.parse(cleanedText);
    } catch (e) {
      context.error("Failed to parse AI response:", text);
      // If JSON parsing fails, try to extract JSON from text
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

    // Validate the response structure
    if (!jsonResponse.recommendations || !Array.isArray(jsonResponse.recommendations)) {
      context.error("Invalid response structure from AI:", jsonResponse);
      throw new Error("Invalid response structure from AI");
    }

    // Ensure we have exactly 3 recommendations
    if (jsonResponse.recommendations.length < 3) {
      context.error("AI did not provide enough recommendations:", jsonResponse.recommendations.length);
      throw new Error("AI did not provide enough recommendations");
    }

    context.log('Updating user testTaken status...');

    // Update user's testTaken status
    await databases.updateDocument(
      DATABASE_ID,
      TALENTS_COLLECTION_ID,
      userData.$id,
      {
        testTaken: true
      }
    );

    // Prepare the response data
    const responseData = {
      success: true,
      recommendations: jsonResponse.recommendations.slice(0, 3), // Ensure only top 3
      generalAdvice: jsonResponse.generalAdvice || "Continue developing your skills and exploring opportunities in your areas of interest.",
      careerStage
    };

    context.log('Career match completed successfully');

    // Return the response using the correct Appwrite Cloud Function format
    return context.res.json(responseData);

  } catch (error) {
    context.error("Error in careerMatch function:", error);
    
    const errorResponse = {
      success: false,
      error: error.message || "An unknown error occurred"
    };
    
    // Return error response using the correct Appwrite Cloud Function format
    return context.res.json(errorResponse);
  }
}