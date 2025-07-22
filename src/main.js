import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

export default async function (context) {
  try {
    // Access environment variables
    const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
    const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
    const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const DATABASE_ID = process.env.DATABASE_ID || 'career4me';
    const TALENTS_COLLECTION_ID = process.env.TALENTS_COLLECTION_ID || 'talents';
    const CAREER_PATHS_COLLECTION_ID = process.env.CAREER_PATHS_COLLECTION_ID || 'careerPaths';

    // Parse request payload
    let userId = null;
    let surveyAnswers = null;
    
    try {
      const payload = JSON.parse(context.req.body || '{}');
      userId = payload.userId;
      surveyAnswers = payload.surveyAnswers;
    } catch (e) {
      context.log('Failed to parse request payload:', e);
    }

    // Get user ID from headers if not in payload
    if (!userId && context.req.headers['x-appwrite-user-id']) {
      userId = context.req.headers['x-appwrite-user-id'];
    }

    // Validate required variables
    if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY || !GEMINI_API_KEY) {
      throw new Error("Missing required environment variables");
    }

    if (!userId) {
      throw new Error("User authentication required");
    }

    // Initialize clients
    const client = new Client()
      .setEndpoint(APPWRITE_ENDPOINT)
      .setProject(APPWRITE_PROJECT_ID)
      .setKey(APPWRITE_API_KEY);

    const databases = new Databases(client);
    
    // Use faster Gemini model
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash", // Faster model
      generationConfig: {
        maxOutputTokens: 1000, // Limit response size
        temperature: 0.7,
      }
    });

    // Fetch user data and career paths in parallel
    const [user, careerPaths] = await Promise.all([
      databases.listDocuments(
        DATABASE_ID,
        TALENTS_COLLECTION_ID,
        [Query.equal("talentId", userId)]
      ),
      databases.listDocuments(
        DATABASE_ID,
        CAREER_PATHS_COLLECTION_ID,
        [Query.limit(10)] // Limit career paths to reduce prompt size
      )
    ]);

    if (user.documents.length === 0) {
      throw new Error("User not found");
    }

    if (careerPaths.documents.length === 0) {
      throw new Error("No career paths found");
    }

    const userData = user.documents[0];
    const careerStage = userData.careerStage;

    // Create simplified user profile
    const createUserProfile = (answers, stage, userData) => {
      if (answers && Object.keys(answers).length > 0) {
        return {
          stage,
          education: answers.educationLevel || 'Not specified',
          skills: [].concat(answers.currentSkills || []).slice(0, 3), // Limit to 3
          interests: [].concat(answers.mainInterests || []).slice(0, 3), // Limit to 3
          fields: [].concat(answers.interestedFields || []).slice(0, 3), // Limit to 3
          currentPath: answers.currentPath || '',
          experience: answers.yearsExperience || '',
          level: answers.seniorityLevel || '',
          goals: answers.careerGoals || '',
          reason: answers.reasonForChange || ''
        };
      } else {
        return {
          stage,
          education: userData.degrees?.join(', ') || 'Not specified',
          skills: (userData.skills || []).slice(0, 3),
          interests: (userData.interests || []).slice(0, 3),
          fields: (userData.interestedFields || []).slice(0, 3),
          currentPath: userData.currentPath || '',
          level: userData.currentSeniorityLevel || ''
        };
      }
    };

    const userProfile = createUserProfile(surveyAnswers, careerStage, userData);

    // Create concise prompt
    const createPrompt = (profile, paths) => {
      let prompt = `Career match for ${profile.stage}:\n`;
      
      // Add only essential profile info
      if (profile.skills.length > 0) prompt += `Skills: ${profile.skills.join(', ')}\n`;
      if (profile.interests.length > 0) prompt += `Interests: ${profile.interests.join(', ')}\n`;
      if (profile.fields.length > 0) prompt += `Fields: ${profile.fields.join(', ')}\n`;
      if (profile.currentPath) prompt += `Current: ${profile.currentPath}\n`;
      if (profile.experience) prompt += `Experience: ${profile.experience}\n`;

      prompt += `\nPaths:\n`;
      paths.forEach(path => {
        prompt += `${path.$id}: ${path.title} - ${path.description.substring(0, 100)}...\n`;
      });

      prompt += `\nReturn JSON with top 3 matches:
{
  "recommendations": [
    {"pathId": "id", "title": "title", "matchScore": 90, "reason": "brief reason", "improvementAreas": ["skill1", "skill2"]}
  ],
  "generalAdvice": "brief advice"
}`;

      return prompt;
    };

    const prompt = createPrompt(userProfile, careerPaths.documents);

    // Set a timeout for the AI call
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('AI request timeout')), 25000) // 25 seconds
    );

    // Make AI call with timeout
    const aiPromise = model.generateContent(prompt);
    
    const result = await Promise.race([aiPromise, timeoutPromise]);
    const response = await result.response;
    const text = response.text();

    // Parse response
    let jsonResponse;
    try {
      const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      jsonResponse = JSON.parse(cleanedText);
    } catch (e) {
      // Fallback: create basic recommendations if AI parsing fails
      const topPaths = careerPaths.documents.slice(0, 3);
      jsonResponse = {
        recommendations: topPaths.map((path, index) => ({
          pathId: path.$id,
          title: path.title,
          matchScore: 85 - (index * 5),
          reason: `Good match based on your ${userProfile.stage} profile`,
          improvementAreas: ["Communication", "Technical Skills"]
        })),
        generalAdvice: "Focus on developing skills that align with your interests and career goals."
      };
    }

    // Ensure valid structure
    if (!jsonResponse.recommendations || !Array.isArray(jsonResponse.recommendations)) {
      throw new Error("Invalid AI response structure");
    }

    // Update user status asynchronously (don't wait for it)
    const updatePromise = databases.updateDocument(
      DATABASE_ID,
      TALENTS_COLLECTION_ID,
      userData.$id,
      { testTaken: true }
    ).catch(err => context.log('Update error:', err));

    // Don't wait for the update to complete
    setTimeout(() => updatePromise, 0);

    // Return response immediately
    const responseData = {
      success: true,
      recommendations: jsonResponse.recommendations.slice(0, 3),
      generalAdvice: jsonResponse.generalAdvice || "Continue developing your skills and exploring opportunities.",
      careerStage
    };

    return context.res.json(responseData);

  } catch (error) {
    context.log("Error in careerMatch function:", error);
    
    return context.res.json({
      success: false,
      error: error.message || "Service temporarily unavailable"
    });
  }
}