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

    // Get user ID from the request context - this is the authenticated user
    let userId = null;
    
    // Try to get user ID from JWT token in headers
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

    // If we still don't have a user ID, try to get it from the request payload
    if (!userId) {
      try {
        const payload = JSON.parse(context.req.body || '{}');
        userId = payload.userId;
      } catch (e) {
        // Ignore JSON parse errors
      }
    }

    // Use context.log for better logging experience
    context.log('Environment variables loaded:', {
      hasEndpoint: !!APPWRITE_ENDPOINT,
      hasProjectId: !!APPWRITE_PROJECT_ID,
      hasApiKey: !!APPWRITE_API_KEY,
      hasGeminiKey: !!GEMINI_API_KEY,
      userId: userId || 'not found'
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
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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
      hasSkills: !!userData.skills,
      hasInterests: !!userData.interests
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

    // Prepare prompt based on career stage
    let prompt = `Based on the following user profile, recommend the top 3 career paths from the provided list. `;
    prompt += `User is a ${careerStage}.\n\n`;

    if (careerStage === "Pathfinder") {
      prompt += `User details:
      - Education: ${userData.degrees?.join(', ') || 'Not specified'}
      - Skills: ${userData.skills?.join(', ') || 'Not specified'}
      - Interests: ${userData.interests?.join(', ') || 'Not specified'}
      - Interested Fields: ${userData.interestedFields?.join(', ') || 'Not specified'}
      `;
    } else if (careerStage === "Trailblazer") {
      prompt += `User details:
      - Current Path: ${userData.currentPath || 'Not specified'}
      - Seniority Level: ${userData.currentSeniorityLevel || 'Not specified'}
      - Education: ${userData.degrees?.join(', ') || 'Not specified'}
      - Skills: ${userData.skills?.join(', ') || 'Not specified'}
      - Interests: ${userData.interests?.join(', ') || 'Not specified'}
      `;
    } else if (careerStage === "Horizon Changer") {
      prompt += `User details:
      - Current Path: ${userData.currentPath || 'Not specified'}
      - Seniority Level: ${userData.currentSeniorityLevel || 'Not specified'}
      - Education: ${userData.degrees?.join(', ') || 'Not specified'}
      - Skills: ${userData.skills?.join(', ') || 'Not specified'}
      - Interests: ${userData.interests?.join(', ') || 'Not specified'}
      - Interested Fields: ${userData.interestedFields?.join(', ') || 'Not specified'}
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